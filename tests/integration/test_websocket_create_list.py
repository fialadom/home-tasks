"""WebSocket tests for home_tasks/create_list (new board from the card)."""
from __future__ import annotations

from unittest.mock import patch

import pytest
from homeassistant.core import HomeAssistant

DOMAIN = "home_tasks"

pytestmark = pytest.mark.integration


async def _create(client, msg_id: int, **kwargs) -> dict:
    await client.send_json({"id": msg_id, "type": "home_tasks/create_list", **kwargs})
    return await client.receive_json()


async def test_create_list_succeeds(
    hass: HomeAssistant, hass_ws_client, mock_config_entry
) -> None:
    client = await hass_ws_client(hass)
    msg = await _create(client, 1, name="Projekty")
    assert msg["success"] is True
    info = msg["result"]["list"]
    assert info["name"] == "Projekty"
    assert info["task_count"] == 0

    entry = hass.config_entries.async_get_entry(info["id"])
    assert entry is not None and entry.domain == DOMAIN
    assert entry.source == "user"
    assert entry.title == "Projekty"
    assert entry.data["name"] == "Projekty"
    assert info["id"] in hass.data[DOMAIN]  # its store exists

    await client.send_json({"id": 2, "type": "home_tasks/get_lists"})
    lists = (await client.receive_json())["result"]["lists"]
    assert info["id"] in {l["id"] for l in lists}
    assert [l for l in lists if l["id"] == info["id"]][0] == info


async def test_create_list_adds_sections_in_order(
    hass: HomeAssistant, hass_ws_client, mock_config_entry
) -> None:
    client = await hass_ws_client(hass)
    msg = await _create(
        client, 1, name="Projekty",
        sections=[
            {"name": "Todo", "icon": "mdi:inbox"},
            {"name": "Doing"},
            {"name": "Done", "icon": "mdi:check"},
        ],
    )
    assert msg["success"] is True
    list_id = msg["result"]["list"]["id"]

    await client.send_json({"id": 2, "type": "home_tasks/get_sections", "list_id": list_id})
    sections = (await client.receive_json())["result"]["sections"]
    assert [s["name"] for s in sections] == ["Todo", "Doing", "Done"]
    assert sections[0]["icon"] == "mdi:inbox"
    assert not sections[1].get("icon")
    assert sections[2]["icon"] == "mdi:check"
    orders = [s["sort_order"] for s in sections]
    assert orders == sorted(orders)


async def test_create_list_duplicate_name(
    hass: HomeAssistant, hass_ws_client, mock_config_entry
) -> None:
    client = await hass_ws_client(hass)
    before = len(hass.config_entries.async_entries(DOMAIN))
    msg = await _create(client, 1, name="test LIST")
    assert msg["success"] is False
    assert msg["error"]["code"] == "duplicate_name"
    assert len(hass.config_entries.async_entries(DOMAIN)) == before
    assert hass.config_entries.flow.async_progress() == []


@pytest.mark.parametrize(
    ("name", "code"),
    [("   ", "empty_name"), ("x" * 101, "name_too_long")],
)
async def test_create_list_invalid_name(
    hass: HomeAssistant, hass_ws_client, mock_config_entry, name, code
) -> None:
    client = await hass_ws_client(hass)
    before = len(hass.config_entries.async_entries(DOMAIN))
    msg = await _create(client, 1, name=name)
    assert msg["success"] is False
    assert msg["error"]["code"] == code
    assert len(hass.config_entries.async_entries(DOMAIN)) == before
    assert hass.config_entries.flow.async_progress() == []


async def test_create_list_max_lists_reached(
    hass: HomeAssistant, hass_ws_client, mock_config_entry
) -> None:
    client = await hass_ws_client(hass)
    count = len(hass.config_entries.async_entries(DOMAIN))
    with patch("custom_components.home_tasks.config_flow.MAX_LISTS", count):
        msg = await _create(client, 1, name="One too many")
    assert msg["success"] is False
    assert msg["error"]["code"] == "max_lists_reached"
    assert len(hass.config_entries.async_entries(DOMAIN)) == count


async def test_create_list_requires_admin(
    hass: HomeAssistant, hass_ws_client, hass_read_only_access_token, mock_config_entry
) -> None:
    client = await hass_ws_client(hass, hass_read_only_access_token)
    before = len(hass.config_entries.async_entries(DOMAIN))
    msg = await _create(client, 1, name="Nope")
    assert msg["success"] is False
    assert msg["error"]["code"] == "unauthorized"
    assert len(hass.config_entries.async_entries(DOMAIN)) == before


async def test_create_list_too_many_sections(
    hass: HomeAssistant, hass_ws_client, mock_config_entry
) -> None:
    client = await hass_ws_client(hass)
    before = len(hass.config_entries.async_entries(DOMAIN))
    msg = await _create(
        client, 1, name="Big", sections=[{"name": f"S{i}"} for i in range(51)]
    )
    assert msg["success"] is False
    assert msg["error"]["code"] == "invalid_format"
    assert len(hass.config_entries.async_entries(DOMAIN)) == before
