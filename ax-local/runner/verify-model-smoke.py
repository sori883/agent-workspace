import asyncio
import importlib.util
import json
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from google.antigravity.models import ModelTarget
from google.antigravity.types import GeminiAPIEndpoint


async def check_case(smoke, root, case):
    workspace = root / case
    workspace.mkdir()
    outside = case in ('outside', 'traversal', 'symlink')
    target = workspace / 'result.txt'
    if case == 'outside':
        target = root / 'outside.txt'
    elif case == 'traversal':
        target = workspace / '..' / 'outside.txt'
    elif case == 'symlink':
        target.symlink_to(root / 'outside.txt')
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            requests.append(request)
            mode = request.get('toolConfig', {}).get('functionCallingConfig', {}).get('mode')
            if (len(requests) == 1 or case in ('budget', 'model-budget', 'malformed')) and mode != 'NONE':
                part = {'functionCall': {'name': 'write_to_file', 'args': {
                    'TargetFile': str(target), 'Overwrite': case in ('budget', 'model-budget'),
                    'CodeContent': 'AX_AGENT_OK\n', 'Description': 'Create the test file.',
                }}}
                if case == 'malformed':
                    part['functionCall']['args'] = {}
            else:
                part = {'text': 'Done.'}
            response = {
                'candidates': [{'content': {'role': 'model', 'parts': [part]},
                                'finishReason': 'STOP', 'index': 0}],
                'usageMetadata': {'promptTokenCount': 100, 'candidatesTokenCount': 20,
                                  'thoughtsTokenCount': 0, 'totalTokenCount': 120},
            }
            payload = ('data: ' + json.dumps(response) + '\n\n').encode()
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    server = HTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    config = smoke.make_config(workspace, 'offline-only')
    if case == 'model-budget':
        config.budget_config.max_tool_calls = 10
    config.models = [ModelTarget(
        name=config.model,
        endpoint=GeminiAPIEndpoint(
            base_url=f'http://127.0.0.1:{server.server_port}', api_key='offline-only',
        ),
    )]
    try:
        await asyncio.wait_for(smoke.run(config, workspace / 'usage.json'), timeout=20)
    finally:
        server.shutdown()
        server.server_close()
    mode = requests[0].get('toolConfig', {}).get('functionCallingConfig', {}).get('mode')
    assert mode != 'NONE', 'Harness disabled tool calls in the model request'
    assert 1 <= len(requests) <= 3, f'Model request budget exceeded: {len(requests)}'
    usage = json.loads((workspace / 'usage.json').read_text())
    if case in ('budget', 'model-budget'):
        expected_calls = 3 if case == 'model-budget' else 2
        expected_stop = 'MAX_MODEL_CALLS_EXCEEDED' if case == 'model-budget' else 'MAX_TOOL_CALLS_EXCEEDED'
        assert len(requests) == expected_calls
        assert usage['stop_reason'] == expected_stop
        print(json.dumps({'case': case, 'local_stub_requests': len(requests),
                          'stop_reason': usage['stop_reason'], 'passed': True}))
        return
    if case == 'malformed':
        assert len(requests) == 2
        assert requests[1]['toolConfig']['functionCallingConfig']['mode'] == 'NONE'
        assert not target.exists()
        print(json.dumps({'case': case, 'local_stub_requests': 2, 'passed': True}))
        return
    assert len(requests) == 2, f'Expected 2 local stub requests, got {len(requests)}'
    usage = json.loads((workspace / 'usage.json').read_text())
    assert usage['usage']['total_token_count'] == 240
    results = [part['functionResponse']['response']
               for message in requests[1]['contents'] for part in message['parts']
               if 'functionResponse' in part]
    if outside:
        assert not target.exists(), 'Workspace boundary was bypassed'
        assert 'denied' in json.dumps(results).lower(), 'Missing explicit denial'
    else:
        assert target.is_file(), f'File tool did not create the file: {results}'
        assert target.read_bytes() == b'AX_AGENT_OK\n'
    print(json.dumps({'case': case,
                      'tool_mode': mode, 'local_stub_requests': len(requests), 'passed': True}))


def main():
    spec = importlib.util.spec_from_file_location('smoke', '/usr/local/bin/ax-model-smoke.py')
    smoke = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(smoke)
    with tempfile.TemporaryDirectory(prefix='ax-offline-') as path:
        for case in ('allowed', 'outside', 'traversal', 'symlink', 'budget', 'model-budget', 'malformed'):
            asyncio.run(check_case(smoke, Path(path), case))


if __name__ == '__main__':
    main()
