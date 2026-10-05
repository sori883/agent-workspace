import json
import logging
import os
from pathlib import Path
import stat

if __package__ == "adapters":
    from protocol import MAX_ARTIFACT_BYTES, validate_name
else:
    from ..protocol import MAX_ARTIFACT_BYTES, validate_name


MODEL = "gemini-3.1-flash-lite"


def make_meter(api_key):
    from .gemini_meter import GeminiMeter

    return GeminiMeter(api_key)


def make_write_output(workspace, output_name):
    validate_name(output_name)
    workspace = Path(workspace)
    initial = workspace.lstat()
    if not stat.S_ISDIR(initial.st_mode):
        raise ValueError("UnsafeOutputDirectory")
    workspace = workspace.resolve(strict=True)
    identity = (initial.st_dev, initial.st_ino)

    def write_output(content: str) -> str:
        """Save the final UTF-8 text output once, then reply briefly without further tool calls."""
        if type(content) is not str:
            raise ValueError("InvalidOutputText")
        if len(content) > MAX_ARTIFACT_BYTES:
            raise ValueError("OutputTooLarge")
        try:
            data = content.encode("utf-8")
        except UnicodeError:
            raise ValueError("InvalidOutputText") from None
        if len(data) > MAX_ARTIFACT_BYTES:
            raise ValueError("OutputTooLarge")
        directory = os.open(workspace, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            current = os.fstat(directory)
            if (current.st_dev, current.st_ino) != identity:
                raise ValueError("OutputDirectoryChanged")
            descriptor = os.open(output_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
            try:
                with os.fdopen(descriptor, "wb") as output:
                    output.write(data)
                    output.flush()
                    os.fsync(output.fileno())
            except Exception:
                os.unlink(output_name, dir_fd=directory)
                raise RuntimeError("OutputWriteFailed") from None
        finally:
            os.close(directory)
        return "Output saved."

    return write_output


def make_config(request, workspace, api_key):
    from google.antigravity import CapabilitiesConfig, LocalAgentConfig
    from google.antigravity.hooks import policy
    from google.antigravity.types import AgentBehavior, BudgetConfig, ModelAPIRetryConfig, ModelOutputRetryConfig, RetryConfig

    state = workspace.parent / "adapter-state"
    return LocalAgentConfig(
        model=MODEL,
        vertex=False,
        api_key=api_key,
        workspaces=[str(workspace)],
        save_dir=str(state),
        app_data_dir=str(state),
        system_instructions=(
            "Complete the requested task using the supplied text context. "
            "Call write_output once with the final output text, then reply briefly. "
            "The output file is fixed by the task; do not supply a file path."
        ),
        tools=[make_write_output(workspace, request["output_name"])],
        capabilities=CapabilitiesConfig(
            enable_subagents=False,
            agent_behavior=AgentBehavior.MINIMAL,
            enabled_tools=[],
            tool_output_truncation_config=128,
        ),
        policies=[policy.allow("write_output")],
        budget_config=BudgetConfig(max_model_calls=3, max_tool_calls=2, max_input_tokens=6000, max_output_tokens=512, max_total_tokens=6512),
        retry_config=RetryConfig(api_retry=ModelAPIRetryConfig(max_retries=0), model_output_retry=ModelOutputRetryConfig(max_retries=1)),
    )


async def run(request, workspace, receipt_path, api_key=None):
    from google.antigravity import Agent
    from google.antigravity.models import ModelTarget
    from google.antigravity.types import GeminiAPIEndpoint

    key = api_key if api_key is not None else os.environ.get("GEMINI_API_KEY", "")
    if not key:
        raise RuntimeError("MissingApiKey")
    logging.disable(logging.CRITICAL)
    prompt = json.dumps({"instruction": request["instruction"], "input_texts": request["inputs"]}, ensure_ascii=False)
    meter = make_meter(key)
    response = None
    completed = False
    try:
        with meter:
            config = make_config(request, workspace, "local-meter")
            config.models = [ModelTarget(name=MODEL, endpoint=GeminiAPIEndpoint(base_url=meter.base_url, api_key="local-meter"))]
            async with Agent(config) as agent:
                response = await agent.chat(prompt)
                await response.text()
            completed = True
    finally:
        metadata = response.usage_metadata if response is not None else None
        usage = meter.usage() if completed else None
        estimate = None
        if usage is not None:
            raw = metadata.model_dump(mode="json") if metadata is not None else {}
            if any(type(raw.get(name)) is not int or raw[name] != value for name, value in usage.items()):
                usage = None
            else:
                tier_factor = 1.8 if str(metadata.service_tier).lower().endswith("priority") else 1
                estimate = round(tier_factor * (usage["prompt_token_count"] * 0.25 + (usage["candidates_token_count"] + usage["thoughts_token_count"]) * 1.50) / 1_000_000, 9)
                usage["model_call_count"] = meter.request_count
        receipt = {"usage": usage, "estimated_usd": estimate, "stop_reason": response.stop_reason.value if response is not None else None}
        with receipt_path.open("x", encoding="utf-8") as output:
            json.dump(receipt, output)
