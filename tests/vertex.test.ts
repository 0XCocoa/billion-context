// src/vertex.ts — the launcher's Vertex AI mapping (phase 1 of the Vertex port).
//
// The reference for the derived host shapes is headroom's
// vertex_target_for_location (headroom/providers/vertex/runtime.py:68-91); the
// reference for why the location is validated before interpolation is the SSRF
// that function once carried (a percent-encoded `#` turning the hostname into a
// fragment and the URL into a GCP metadata-endpoint reach).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    normalizeVertexModelId,
    vertexBaseUrlForLocation,
    vertexBaseUrlLacksV1,
    vertexEnabled,
    vertexHostForLocation,
} from "../src/vertex.ts";

test("vertexHostForLocation: global / multi-region / regional host shapes", () => {
    assert.deepEqual(vertexHostForLocation("global"), { host: "https://aiplatform.googleapis.com", location: "global", source: "derived" });
    assert.deepEqual(vertexHostForLocation("us"), { host: "https://aiplatform.us.rep.googleapis.com", location: "us", source: "derived" });
    assert.deepEqual(vertexHostForLocation("eu"), { host: "https://aiplatform.eu.rep.googleapis.com", location: "eu", source: "derived" });
    // A regional location is a prefix, the opposite of the multi-region form.
    assert.deepEqual(vertexHostForLocation("us-east5"), { host: "https://us-east5-aiplatform.googleapis.com", location: "us-east5", source: "derived" });
    // Case and surrounding whitespace are normalized, not rejected: the value
    // comes from a hand-edited settings file.
    assert.deepEqual(vertexHostForLocation("  GLOBAL "), { host: "https://aiplatform.googleapis.com", location: "global", source: "derived" });
});

test("vertexHostForLocation: an explicit base URL wins outright, region or not", () => {
    const explicit = "https://private-endpoint.example/vertex";
    assert.deepEqual(vertexHostForLocation("global", explicit), { host: explicit, location: null, source: "explicit" });
    assert.deepEqual(vertexHostForLocation(undefined, explicit), { host: explicit, location: null, source: "explicit" });
    assert.deepEqual(vertexHostForLocation("not a location!!", explicit), { host: explicit, location: null, source: "explicit" });
});

test("vertexHostForLocation: nothing derivable returns null (never a guessed region)", () => {
    assert.equal(vertexHostForLocation(undefined), null);
    assert.equal(vertexHostForLocation(""), null);
    assert.equal(vertexHostForLocation("   "), null);
    // This project is global-only; a fabricated region answers 404 everywhere,
    // so the caller warns and leaves the variable unset instead.
    // Validation is syntactic only — a well-formed but nonexistent location still
    // derives a host rather than being guessed at from a hardcoded region list
    // that would go stale against Google's.
    assert.deepEqual(vertexHostForLocation("nowhere-1"), { host: "https://nowhere-1-aiplatform.googleapis.com", location: "nowhere-1", source: "derived" });
});

test("vertexHostForLocation: SSRF- and traversal-shaped locations are rejected", () => {
    // The percent-encoded `#` is the documented one: decoded it becomes a
    // fragment, and `https://169.254.169.254#-aiplatform.googleapis.com` reads
    // as host 169.254.169.254 to an HTTP client.
    assert.equal(vertexHostForLocation("169.254.169.254#"), null);
    assert.equal(vertexHostForLocation("169.254.169.254%23"), null);
    assert.equal(vertexHostForLocation("us-east5#"), null);
    // Dots, slashes and credentials never belong in a location label.
    assert.equal(vertexHostForLocation(".."), null);
    assert.equal(vertexHostForLocation("us-east5/../x"), null);
    assert.equal(vertexHostForLocation("evil.com"), null);
    assert.equal(vertexHostForLocation("us-east5@evil.com"), null);
    // Nor an empty label between hyphens.
    assert.equal(vertexHostForLocation("us--east5"), null);
    assert.equal(vertexHostForLocation("-us-east5"), null);
    assert.equal(vertexHostForLocation("us-east5-"), null);
});

test("vertexBaseUrlForLocation: derived gets /v1, explicit is handed over untouched", () => {
    assert.equal(vertexBaseUrlForLocation("global"), "https://aiplatform.googleapis.com/v1");
    assert.equal(vertexBaseUrlForLocation("us-east5"), "https://us-east5-aiplatform.googleapis.com/v1");
    // The client appends /projects/… to this value verbatim and Vertex 404s the
    // version-less path, hence the segment for derived values only.
    assert.equal(vertexBaseUrlForLocation(undefined, "https://gateway.example/vertex"), "https://gateway.example/vertex");
    assert.equal(vertexBaseUrlForLocation("us-east5", " https://gateway.example/v1 "), "https://gateway.example/v1");
    assert.equal(vertexBaseUrlForLocation(undefined), null);
    assert.equal(vertexBaseUrlForLocation("not a location!!"), null);
});

test("vertexBaseUrlLacksV1: warns on the shape that 404s, not on a trailing slash", () => {
    assert.equal(vertexBaseUrlLacksV1("https://aiplatform.googleapis.com/v1"), false);
    assert.equal(vertexBaseUrlLacksV1("https://aiplatform.googleapis.com/v1/"), false);
    assert.equal(vertexBaseUrlLacksV1(" https://gateway.example/v1 "), false);
    assert.equal(vertexBaseUrlLacksV1("https://aiplatform.googleapis.com"), true);
    assert.equal(vertexBaseUrlLacksV1("https://gateway.example/vertex"), true);
});

test("vertexEnabled: Claude Code's switch, unset/falsey off", () => {
    assert.equal(vertexEnabled({}), false);
    assert.equal(vertexEnabled({ CLAUDE_CODE_USE_VERTEX: "" }), false);
    assert.equal(vertexEnabled({ CLAUDE_CODE_USE_VERTEX: "   " }), false);
    for (const off of ["0", "false", "FALSE", "no", "off", " False "]) {
        assert.equal(vertexEnabled({ CLAUDE_CODE_USE_VERTEX: off }), false, `${JSON.stringify(off)} must be off`);
    }
    for (const on of ["1", "true", "yes", "on", "TRUE"]) {
        assert.equal(vertexEnabled({ CLAUDE_CODE_USE_VERTEX: on }), true, `${JSON.stringify(on)} must be on`);
    }
});

test("normalizeVertexModelId: bare ids pass through, date suffixes strip", () => {
    // Verification evidence: `claude-haiku-5-5` is GA and bare on the wire while
    // `claude-haiku-4-5@20251001` carries a date — both callable (live probe).
    assert.equal(normalizeVertexModelId("claude-haiku-5-5"), "claude-haiku-5-5");
    assert.equal(normalizeVertexModelId("claude-haiku-4-5@20251001"), "claude-haiku-4-5");
    assert.equal(normalizeVertexModelId(" claude-sonnet-4-5@20250929 "), "claude-sonnet-4-5");
    // A leading @ is not a suffix; neither is an empty string.
    assert.equal(normalizeVertexModelId("@20251001"), "@20251001");
    assert.equal(normalizeVertexModelId(""), "");
    // Only the first suffix strips (ids may carry several @ segments in theory).
    assert.equal(normalizeVertexModelId("a@b@c"), "a");
});
