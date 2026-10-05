import json


def run(request, workspace, receipt_path):
    content = "".join(request["inputs"].values()) if request["inputs"] else request["instruction"]
    with (workspace / request["output_name"]).open("x", encoding="utf-8") as output:
        output.write(content)
    receipt = {
        "usage": {"prompt_token_count": 0, "candidates_token_count": 0, "thoughts_token_count": 0, "total_token_count": 0},
        "estimated_usd": 0,
        "stop_reason": "OFFLINE",
    }
    with receipt_path.open("x", encoding="utf-8") as output:
        json.dump(receipt, output)
