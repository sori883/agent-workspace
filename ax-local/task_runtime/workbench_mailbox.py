if __package__:
    from .mailbox import Mailbox
    from .workbench_protocol import validate_request, validate_proposal, json_bytes
else:
    from mailbox import Mailbox
    from workbench_protocol import validate_request, validate_proposal, json_bytes


class WorkbenchMailbox(Mailbox):
    version = 2
    validate_request = staticmethod(validate_request)
    validate_proposal = staticmethod(validate_proposal)

    def _phase(self, request):
        return None

    def publish(self, kind, body):
        json_bytes({"version": 2, "run_id": self.run_id, "sequence": 1 if kind == "model" else 2,
                    "kind": kind, "body": body}, 48000)
        return super().publish(kind, body)
