"""Validate synthetic authenticated C2 HTTP exchanges against root wire schemas.

``capture_policy_wire_cases`` also supplies actual exchanges for a separate Bun
Zod check; the ordinary Python suite intentionally has no Bun dependency.
"""
from copy import deepcopy
import json
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker
import pytest

from test_app import AUTH, fit_payload, request
from test_policy_association import body, cleanup_event, prepare, publish, receipt
from test_policy_protocol_compat import downgrade, single
from test_policy_reservations import Clock, make_app, release_payload


CONTRACTS = json.loads(
    (Path(__file__).resolve().parents[3] / "packages/contracts/generated/contracts.schema.json").read_text()
)
ROUTES = ("policySelect", "policyAssociate", "policyRelease", "policyExposure", "policyDiagnostics")


def capture_policy_wire_cases(directory):
    """Exercise real ASGI routes, retaining only synthetic requests/responses."""
    cases = []

    def capture(app, route_name, name, payload):
        route = CONTRACTS["internalRoutes"][route_name]
        kwargs = {"json" if route["method"] == "POST" else "params": deepcopy(payload)}
        response = request(app, route["method"], route["path"], AUTH, **kwargs)
        assert response.status_code == 200, (name, response.text)
        result = response.json()
        cases.append({"name": name, "route": route_name, "request": deepcopy(payload), "response": result})
        return result

    def inspect(app, name, selected):
        return capture(app, "policyExposure", name,
                       {"userId": selected["userId"], "exposureId": selected["exposureId"]})

    def diagnostics(app, name):
        return capture(app, "policyDiagnostics", name, {"userId": "demo:alice"})

    clock = Clock()
    app = make_app(directory / "cold", clock)
    selected = capture(app, "policySelect", "cold_select", single())
    inspect(app, "cold_active_exposure", selected)
    diagnostics(app, "cold_diagnostics")
    clock.advance(-1)
    inspect(app, "active_clock_rollback_exposure", selected)
    capture(app, "policyRelease", "explicit_release_during_clock_rollback", release_payload(selected))
    inspect(app, "released_during_clock_rollback_exposure", selected)

    clock = Clock()
    app = make_app(directory / "pinned", clock)
    fitted = request(app, "POST", "/fit", AUTH, json=fit_payload())
    assert fitted.status_code == 200, fitted.text
    selected = capture(app, "policySelect", "pinned_select", {
        **single(), "modelVersion": fitted.json()["modelVersion"], "feedbackRevision": fitted.json()["feedbackRevision"]})
    inspect(app, "pinned_active_exposure", selected)
    diagnostics(app, "pinned_diagnostics")

    for version in (1, 2):
        folder = directory / f"legacy{version}"
        clock = Clock()
        app = make_app(folder, clock)
        selected = request(app, "POST", "/policy/select", AUTH, json=single())
        assert selected.status_code == 200, selected.text
        downgrade(folder, version)
        restored = make_app(folder, clock)
        selected = capture(restored, "policySelect", f"legacy{version}_select", single())
        inspect(restored, f"legacy{version}_exposure", selected)
        diagnostics(restored, f"legacy{version}_diagnostics")

    clock = Clock()
    app = make_app(directory / "release", clock)
    selected = capture(app, "policySelect", "release_select", single())
    clock.advance(10)
    capture(app, "policyRelease", "explicit_release", release_payload(selected))
    capture(app, "policyRelease", "explicit_release_duplicate", release_payload(selected))
    inspect(app, "explicit_release_exposure", selected)
    diagnostics(app, "explicit_release_diagnostics")
    clock.advance(-20)
    inspect(app, "release_clock_rollback_exposure", selected)

    clock = Clock()
    app = make_app(directory / "expiry", clock)
    selected = capture(app, "policySelect", "expiry_select", single())
    clock.advance(300)
    inspect(app, "expired_exposure", selected)
    capture(app, "policyRelease", "release_after_expiry", release_payload(selected))
    diagnostics(app, "expired_diagnostics")
    clock.advance(-200)
    inspect(app, "expiry_clock_rollback_exposure", selected)

    clock = Clock()
    app = make_app(directory / "skip", clock)
    selected = capture(app, "policySelect", "skip_select", single())
    empty_fit = {**fit_payload(), "examples": []}
    fitted = request(app, "POST", "/fit", AUTH, json=empty_fit)
    assert fitted.status_code == 200, fitted.text
    skipped = cleanup_event(selected, revision=1, label=None)
    capture(app, "policyAssociate", "skip_association", body(skipped, receipt(fitted.json())))
    inspect(app, "skip_exposure", selected)
    capture(app, "policyRelease", "release_after_skip", release_payload(selected))
    diagnostics(app, "skip_diagnostics")

    app, clock, selected, cleanup, snapshot, fitted = prepare(directory / "undo")
    capture(app, "policyAssociate", "strong_association_before_undo", body(cleanup, fitted))
    revoked = cleanup_event(selected, number=6001, sequence=2, revision=3, operation="revoke", label=None)
    _, undo_fit = publish(app, snapshot, revoked)
    capture(app, "policyAssociate", "revoke_association", body(revoked, undo_fit))
    inspect(app, "revoked_exposure", selected)
    capture(app, "policyRelease", "release_after_revoke", release_payload(selected))
    diagnostics(app, "revoked_diagnostics")

    app, clock, selected, cleanup, snapshot, fitted = prepare(directory / "advanced")
    capture(app, "policyAssociate", "original_association", body(cleanup, fitted))
    _, advanced = publish(app, snapshot, revision=3)
    clock.advance(1)
    capture(app, "policyAssociate", "advanced_duplicate_association", body(cleanup, advanced))
    inspect(app, "advanced_duplicate_exposure", selected)
    diagnostics(app, "advanced_duplicate_diagnostics")
    return cases


@pytest.fixture(scope="module")
def wire_cases(tmp_path_factory):
    return capture_policy_wire_cases(tmp_path_factory.mktemp("policy-wire"))


@pytest.mark.parametrize("route_name", ROUTES)
def test_authenticated_policy_exchanges_match_generated_internal_route_schemas(wire_cases, route_name):
    route = CONTRACTS["internalRoutes"][route_name]
    assert route["auth"] == "shared_secret"
    payload_schema = route["body" if route["method"] == "POST" else "query"]
    input_validator = Draft202012Validator(payload_schema, format_checker=FormatChecker())
    output_validator = Draft202012Validator(route["response"], format_checker=FormatChecker())
    selected = [case for case in wire_cases if case["route"] == route_name]
    assert selected
    for case in selected:
        assert not list(input_validator.iter_errors(case["request"])), case["name"]
        assert not list(output_validator.iter_errors(case["response"])), case["name"]


def test_wire_snapshots_preserve_optional_revisions_and_lifecycle_meaning(wire_cases):
    rows = {case["name"]: case["response"] for case in wire_cases}
    assert rows["pinned_select"]["feedbackRevision"] == 1
    assert rows["cold_select"]["feedbackRevision"] is None
    for version in (1, 2):
        assert "feedbackRevision" not in rows[f"legacy{version}_select"]
        assert "feedbackRevision" not in rows[f"legacy{version}_exposure"]["decision"]
    assert rows["explicit_release_exposure"]["reservation"]["closureReason"] == "explicit_release"
    assert rows["skip_exposure"]["reservation"]["closureReason"] == "skip"
    assert rows["revoked_exposure"]["reservation"]["closureReason"] == "undo"
    assert rows["expired_exposure"]["reservation"]["closureReason"] == "expiry"
    assert rows["explicit_release"] == rows["explicit_release_duplicate"]
    assert rows["advanced_duplicate_association"]["duplicate"] is True
    assert rows["advanced_duplicate_association"]["recordedAt"] == rows["original_association"]["recordedAt"]
    assert rows["advanced_duplicate_association"]["fitReceipt"]["synchronizedFeedbackRevision"] == 3
    assert rows["advanced_duplicate_association"]["fitReceipt"] != rows["original_association"]["fitReceipt"]
