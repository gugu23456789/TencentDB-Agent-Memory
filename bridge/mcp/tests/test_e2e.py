"""E2E test: Bridge server -> BridgeAdapter -> Mock Gateway -> Gates.

Starts a mock Gateway HTTP server, feeds JSON-RPC to the Bridge server,
and verifies the full pipeline: gates fire, adapter calls reach Gateway,
responses flow back.

NOTE: Rate-limit and circuit-breaker gates cannot be tested via subprocess
because each call starts a fresh Python process (in-memory state resets).
They are covered by unit tests in test_dual_path.py and gate-*.test.ts.

Usage:
    pytest bridge/mcp/tests/test_e2e.py -v

No external dependencies required. Mock Gateway is in-process.
"""

import json
import os
import subprocess
import sys
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from typing import Any, Dict

import pytest


# ============================================================
# Mock Gateway -- returns responses matching TDAI Gateway format
# ============================================================

_MOCK_RESPONSES: Dict[str, Dict[str, Any]] = {
    # /v2/atomic/search -> search_atomic()
    "/v2/atomic/search": {
        "results": [
            {"content": "mock memory content about project plans", "type": "observation", "id": "m1"},
            {"content": "mock memory about coding patterns", "type": "observation", "id": "m2"},
        ]
    },
    # /v2/core/read -> read_core()
    "/v2/core/read": {
        "code": 0,
        "content": "User core profile: interested in E2E testing and Python development",
    },
    # /v2/scenario/ls -> list_scenarios()
    "/v2/scenario/ls": {"entries": []},
    # /v2/conversation/add -> add_conversation()
    "/v2/conversation/add": {"code": 0, "l0_recorded": 1},
    # /v2/conversation/query -> query_conversation()
    "/v2/conversation/query": {"code": 0, "messages": []},
    # /v2/conversation/search -> search_conversation()
    "/v2/conversation/search": {"code": 0, "results": []},
    # /health -> health()
    "/health": {"status": "ok", "uptime": 42, "stores": {"vectorStore": True, "embeddingService": True}},
}


class MockGatewayHandler(BaseHTTPRequestHandler):
    """Minimal mock TDAI Gateway for E2E testing."""

    def log_message(self, format, *args):
        pass

    def _send_json(self, status: int, data: Dict[str, Any]):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        resp = _MOCK_RESPONSES.get(self.path)
        if resp:
            self._send_json(200, resp)
        else:
            self._send_json(404, {"error": f"not found: {self.path}"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        if length > 0:
            body = json.loads(self.rfile.read(length))
        else:
            body = {}

        resp = _MOCK_RESPONSES.get(self.path)
        if resp:
            self._send_json(200, resp)
        else:
            self._send_json(404, {"error": f"unknown path: {self.path}"})


@pytest.fixture(scope="module")
def mock_gateway_port():
    """Start mock Gateway on a random port, yield port number."""
    server = HTTPServer(("127.0.0.1", 0), MockGatewayHandler)
    port = server.server_address[1]
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    yield port
    server.shutdown()


# ============================================================
# Helper: run Bridge server with a JSON-RPC request
# ============================================================


def _bridge_call(mock_gateway_port: int, request: Dict[str, Any]) -> Dict[str, Any]:
    """Feed a JSON-RPC request to bridge/mcp/server.py and return parsed response."""
    project_root = os.path.join(os.path.dirname(__file__), "..", "..", "..")
    env = os.environ.copy()
    env["TDAI_ENDPOINT"] = f"http://127.0.0.1:{mock_gateway_port}"
    env["MCP_BRIDGE_API_KEY"] = ""

    result = subprocess.run(
        [sys.executable, "-m", "bridge.mcp.server"],
        input=json.dumps(request),
        capture_output=True,
        text=True,
        timeout=10,
        env=env,
        cwd=project_root,
    )
    assert result.returncode == 0, f"Bridge server failed: {result.stderr}"
    return json.loads(result.stdout.strip())


# ============================================================
# Tests -- protocol + tools + gates
# ============================================================


class TestBridgeE2E:
    """E2E tests against mock Gateway."""

    def test_initialize(self, mock_gateway_port):
        """MCP initialize bypasses gates and returns protocol version."""
        resp = _bridge_call(mock_gateway_port, {
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {"protocolVersion": "2025-03-26", "capabilities": {},
                       "clientInfo": {"name": "test", "version": "0.0.1"}},
        })
        assert resp["result"]["protocolVersion"] == "2025-03-26"
        assert resp["result"]["serverInfo"]["name"] == "bridge-mcp"

    def test_tools_list(self, mock_gateway_port):
        """tools/list returns 5 tool definitions, bypasses gates."""
        resp = _bridge_call(mock_gateway_port, {
            "jsonrpc": "2.0", "id": 2, "method": "tools/list",
        })
        tools = resp["result"]["tools"]
        assert len(tools) == 5
        names = [t["name"] for t in tools]
        assert "tdai_health" in names
        assert "tdai_recall" in names
        assert "tdai_capture" in names
        assert "tdai_memory_search" in names
        assert "tdai_conversation_search" in names

    def test_tdai_health(self, mock_gateway_port):
        """tdai_health calls Gateway /health and returns available status."""
        resp = _bridge_call(mock_gateway_port, {
            "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": {"name": "tdai_health", "arguments": {}},
        })
        content = json.loads(resp["result"]["content"][0]["text"])
        assert content["available"] is True, f"Expected available=True, got {content}"

    def test_tdai_recall(self, mock_gateway_port):
        """tdai_recall goes through gates, reaches mock Gateway, returns context."""
        resp = _bridge_call(mock_gateway_port, {
            "jsonrpc": "2.0", "id": 4, "method": "tools/call",
            "params": {"name": "tdai_recall", "arguments": {"query": "test query"}},
        })
        content_text = resp["result"]["content"][0]["text"]
        assert "prepend_context" in content_text
        assert "append_system_context" in content_text

    def test_tdai_capture(self, mock_gateway_port):
        """tdai_capture goes through gates, reaches mock Gateway, returns a response."""
        resp = _bridge_call(mock_gateway_port, {
            "jsonrpc": "2.0", "id": 5, "method": "tools/call",
            "params": {
                "name": "tdai_capture",
                "arguments": {
                    "user_content": "hello",
                    "assistant_content": "world",
                    "session_id": "test-session",
                },
            },
        })
        # Verify the capture response is valid JSON with a success field
        content = json.loads(resp["result"]["content"][0]["text"])
        assert "success" in content, f"Expected 'success' field in response, got {content}"

    def test_gate_unknown_tool(self, mock_gateway_port):
        """Unknown tool name returns -32601."""
        resp = _bridge_call(mock_gateway_port, {
            "jsonrpc": "2.0", "id": 200, "method": "tools/call",
            "params": {"name": "nonexistent_tool", "arguments": {}},
        })
        assert resp["error"]["code"] == -32601

    def test_invalid_json_rpc_validation(self, mock_gateway_port):
        """Missing jsonrpc field returns -32600."""
        resp = _bridge_call(mock_gateway_port, {
            "method": 123,
        })
        assert resp["error"]["code"] == -32600

    def test_gate_api_key_rejects_when_configured(self, mock_gateway_port):
        """When MCP_BRIDGE_API_KEY is set, missing key is rejected."""
        project_root = os.path.join(os.path.dirname(__file__), "..", "..", "..")
        env = os.environ.copy()
        env["TDAI_ENDPOINT"] = f"http://127.0.0.1:{mock_gateway_port}"
        env["MCP_BRIDGE_API_KEY"] = "test-key-123"

        result = subprocess.run(
            [sys.executable, "-m", "bridge.mcp.server"],
            input=json.dumps({
                "jsonrpc": "2.0", "id": 300, "method": "tools/call",
                "params": {"name": "tdai_health", "arguments": {}},
            }),
            capture_output=True, text=True, timeout=10,
            env=env,
            cwd=project_root,
        )
        resp = json.loads(result.stdout.strip())
        assert resp["error"]["code"] == -32001
