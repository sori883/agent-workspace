import argparse
import asyncio
import json
import logging
import os
from pathlib import Path

from google.antigravity import Agent, CapabilitiesConfig, LocalAgentConfig
from google.antigravity.hooks import policy
from google.antigravity.types import (
    AgentBehavior,
    BudgetConfig,
    BuiltinTools,
    ModelAPIRetryConfig,
    ModelOutputRetryConfig,
    RetryConfig,
)


def make_config(workspace, api_key):
    def outside_result_file(arguments):
        target = arguments.get("TargetFile")
        if not isinstance(target, str) or not target:
            return True
        path = Path(target)
        return not path.is_absolute() or path.resolve() != workspace.resolve() / "result.txt"

    return LocalAgentConfig(
        model="gemini-3.1-flash-lite",
        vertex=False,
        api_key=api_key,
        workspaces=[str(workspace)],
        save_dir="/workspace/antigravity-state",
        app_data_dir="/workspace/antigravity-state",
        system_instructions="Create only the requested file, then finish. Keep responses short.",
        capabilities=CapabilitiesConfig(
            enable_subagents=False,
            agent_behavior=AgentBehavior.MINIMAL,
            enabled_tools=[BuiltinTools.CREATE_FILE, BuiltinTools.FINISH],
            tool_output_truncation_config=128,
        ),
        policies=[
            *policy.workspace_only([str(workspace)]),
            policy.deny(
                BuiltinTools.CREATE_FILE,
                when=outside_result_file,
                reason="Only result.txt in the trial workspace may be created",
            ),
            policy.allow(BuiltinTools.CREATE_FILE),
            policy.allow(BuiltinTools.FINISH),
        ],
        budget_config=BudgetConfig(
            max_model_calls=3,
            max_tool_calls=2,
            max_input_tokens=6000,
            max_output_tokens=512,
            max_total_tokens=6512,
        ),
        retry_config=RetryConfig(
            api_retry=ModelAPIRetryConfig(max_retries=0),
            model_output_retry=ModelOutputRetryConfig(max_retries=1),
        ),
    )


async def run(config, usage_path):
    async with Agent(config) as agent:
        response = await agent.chat(
            "Create result.txt in the workspace with exactly AX_AGENT_OK followed by a newline. "
            "Then finish. Do not create any other files."
        )
        try:
            await response.text()
        finally:
            usage = response.usage_metadata
            record = {
                "model": config.model,
                "usage": usage.model_dump(mode="json") if usage is not None else None,
                "stop_reason": response.stop_reason.value,
                "estimated_usd": None,
                "estimate_basis": "2026-10-05 standard text rates; cached input discounted only on invoice",
            }
            if usage is not None and all(value is not None for value in (
                usage.prompt_token_count, usage.candidates_token_count, usage.thoughts_token_count,
            )):
                tier_factor = 1.8 if str(usage.service_tier).lower().endswith("priority") else 1
                record["estimated_usd"] = round(tier_factor * (
                    usage.prompt_token_count * 0.25
                    + (usage.candidates_token_count + usage.thoughts_token_count) * 1.50
                ) / 1_000_000, 9)
            usage_path.write_text(json.dumps(record, indent=2) + "\n")
            print("MODEL_USAGE " + json.dumps(record), flush=True)
        if record["estimated_usd"] is None:
            raise RuntimeError("Token usage unavailable; do not automatically repeat")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--validate-only", action="store_true")
    parser.add_argument("--workspace", default="/workspace/model-smoke")
    args = parser.parse_args()
    workspace = Path(args.workspace).resolve()
    key = "offline-validation-only" if args.validate_only else os.environ.get("GEMINI_API_KEY", "")
    if not key:
        raise SystemExit("GEMINI_API_KEY is required")
    config = make_config(workspace, key)
    print(json.dumps({
        "model": config.model,
        "budget": config.budget_config.model_dump(mode="json"),
        "retry": config.retry_config.model_dump(mode="json"),
        "tools": config.capabilities.enabled_tools,
    }), flush=True)
    if args.validate_only:
        return
    workspace.mkdir(parents=True, exist_ok=True)
    try:
        with (workspace / "attempted").open("x") as marker:
            marker.write("single model trial started\n")
    except FileExistsError:
        raise SystemExit("MODEL_SMOKE_REFUSED: trial already attempted") from None
    os.chdir(workspace)
    logging.disable(logging.CRITICAL)
    try:
        asyncio.run(asyncio.wait_for(run(config, workspace / "usage.json"), timeout=80))
    except Exception as error:
        print(f"MODEL_SMOKE_FAILED: {type(error).__name__}", flush=True)
        raise SystemExit(1) from None
    if (workspace / "result.txt").read_bytes() != b"AX_AGENT_OK\n":
        raise SystemExit("MODEL_SMOKE_FAILED: output mismatch")
    print("MODEL_OUTPUT_VERIFIED", flush=True)


if __name__ == "__main__":
    main()
