"""Task comments with @mentions: WS commands, events, the service, moves."""
from __future__ import annotations

from unittest.mock import patch

import pytest
from homeassistant.auth.const import GROUP_ID_USER
from homeassistant.core import Context, HomeAssistant
from homeassistant.setup import async_setup_component
from pytest_homeassistant_custom_component.common import (
    MockConfigEntry,
    async_capture_events,
)

from custom_components.home_tasks.const import MAX_COMMENT_LENGTH

pytestmark = pytest.mark.integration

DOMAIN = "home_tasks"
CLIENT_ID = "https://example.com/app"


@pytest.fixture
async def people(hass: HomeAssistant, hass_admin_user) -> None:
    """person.kevin (the admin user), person.anna and person.ben (no users)."""
    assert await async_setup_component(hass, "person", {"person": [
        {"id": "kevin", "name": "Kevin", "user_id": hass_admin_user.id},
        {"id": "anna", "name": "Anna"},
        {"id": "ben", "name": "Ben"},
    ]})
    await hass.async_block_till_done()


@pytest.fixture
async def member(hass: HomeAssistant):
    """A regular (non-admin) user."""
    return await hass.auth.async_create_user("Member", group_ids=[GROUP_ID_USER])


async def _client_for(hass: HomeAssistant, hass_ws_client, user):
    refresh = await hass.auth.async_create_refresh_token(user, CLIENT_ID)
    return await hass_ws_client(hass, hass.auth.async_create_access_token(refresh))


async def _call(client, type_: str, **fields) -> dict:
    await client.send_json_auto_id({"type": f"home_tasks/{type_}", **fields})
    return await client.receive_json()


async def test_add_comment_stores_author_and_mentions(
    hass: HomeAssistant, hass_ws_client, hass_admin_user, mock_config_entry, store, people
) -> None:
    task = await store.async_add_task("Task")
    client = await hass_ws_client(hass)
    msg = await _call(
        client, "add_comment", list_id=mock_config_entry.entry_id, task_id=task["id"],
        text="<@person.anna> look <@person.anna> <@person.ben>",
    )
    assert msg["success"]
    comment = msg["result"]
    assert comment["by"] == hass_admin_user.name
    assert comment["by_user_id"] == hass_admin_user.id
    assert comment["by_person"] == "person.kevin"
    assert comment["mentions"] == ["person.anna", "person.ben"]
    assert store.get_task(task["id"])["comments"] == [comment]
    # get_tasks hands the comments out with the task.
    listed = await _call(client, "get_tasks", list_id=mock_config_entry.entry_id)
    assert listed["result"]["tasks"][0]["comments"] == [comment]


async def test_add_comment_errors(
    hass: HomeAssistant, hass_ws_client, mock_config_entry, store, people
) -> None:
    task = await store.async_add_task("Task")
    client = await hass_ws_client(hass)
    base = {"list_id": mock_config_entry.entry_id, "task_id": task["id"]}

    msg = await _call(client, "add_comment", **base, text="hi <@person.ghost>")
    assert msg["error"]["code"] == "unknown_person"

    many = " ".join(f"<@person.p{i}>" for i in range(11))
    hass.states.async_set("person.p0", "home")
    for i in range(11):
        hass.states.async_set(f"person.p{i}", "home")
    msg = await _call(client, "add_comment", **base, text=many)
    assert msg["error"]["code"] == "too_many_mentions"

    for text in ("", "   ", "x" * (MAX_COMMENT_LENGTH + 1)):
        msg = await _call(client, "add_comment", **base, text=text)
        assert msg["error"]["code"] == "invalid_request", text
    msg = await _call(client, "add_comment", **{**base, "task_id": "nope"}, text="hi")
    assert msg["error"]["code"] == "invalid_request"
    assert store.get_task(task["id"])["comments"] == []


async def test_update_and_delete_permissions(
    hass: HomeAssistant, hass_ws_client, hass_admin_user, member, mock_config_entry, store, people
) -> None:
    task = await store.async_add_task("Task")
    base = {"list_id": mock_config_entry.entry_id, "task_id": task["id"]}
    admin = await hass_ws_client(hass)
    other = await _client_for(hass, hass_ws_client, member)

    admins = (await _call(admin, "add_comment", **base, text="by the admin"))["result"]
    mine = (await _call(other, "add_comment", **base, text="by the member"))["result"]
    assert mine["by_person"] is None  # the member has no person

    # A non-admin cannot touch someone else's comment.
    msg = await _call(other, "update_comment", **base, comment_id=admins["id"], text="hijack")
    assert msg["error"]["code"] == "unauthorized"
    msg = await _call(other, "delete_comment", **base, comment_id=admins["id"])
    assert msg["error"]["code"] == "unauthorized"

    # The author can edit and delete their own.
    msg = await _call(other, "update_comment", **base, comment_id=mine["id"], text="edited <@person.anna>")
    assert msg["success"]
    assert msg["result"]["mentions"] == ["person.anna"] and msg["result"]["edited_ts"]

    # An admin may change anyone's comment.
    msg = await _call(admin, "update_comment", **base, comment_id=mine["id"], text="admin edit")
    assert msg["success"]
    msg = await _call(admin, "delete_comment", **base, comment_id=mine["id"])
    assert msg == {**msg, "success": True, "result": {}}
    msg = await _call(other, "delete_comment", **base, comment_id=admins["id"])
    assert msg["error"]["code"] == "unauthorized"
    msg = await _call(admin, "delete_comment", **base, comment_id=mine["id"])
    assert msg["error"]["code"] == "invalid_request"  # already gone
    assert [c["id"] for c in store.get_task(task["id"])["comments"]] == [admins["id"]]

    # Unknown persons are rejected on edit as well.
    msg = await _call(admin, "update_comment", **base, comment_id=admins["id"], text="<@person.ghost>")
    assert msg["error"]["code"] == "unknown_person"


async def test_comment_added_event_has_rendered_text(
    hass: HomeAssistant, hass_ws_client, hass_admin_user, mock_config_entry, store, people
) -> None:
    task = await store.async_add_task("Task", assigned_person="person.anna")
    added = async_capture_events(hass, f"{DOMAIN}_comment_added")
    client = await hass_ws_client(hass)
    msg = await _call(
        client, "add_comment", list_id=mock_config_entry.entry_id, task_id=task["id"],
        text="<@person.anna> see this",
    )
    comment = msg["result"]
    await hass.async_block_till_done()

    (event,) = added
    assert event.data["entry_id"] == mock_config_entry.entry_id
    assert event.data["task_id"] == task["id"]
    assert event.data["task_title"] == "Task"
    assert event.data["assigned_person"] == "person.anna"
    assert event.data["comment_id"] == comment["id"]
    assert event.data["by"] == hass_admin_user.name
    assert event.data["by_user_id"] == hass_admin_user.id
    assert event.data["by_person"] == "person.kevin"
    assert event.data["mentions"] == ["person.anna"]
    assert event.data["text"] == "@Anna see this"
    assert event.context.user_id == hass_admin_user.id


async def test_event_text_falls_back_to_entity_id_and_is_truncated(
    hass: HomeAssistant, mock_config_entry, store, people
) -> None:
    task = await store.async_add_task("Task")
    added = async_capture_events(hass, f"{DOMAIN}_comment_added")
    # The person is gone by the time the event fires; no author at all.
    await store.async_add_comment(task["id"], "<@person.gone> " + "y" * 400)
    await hass.async_block_till_done()
    (event,) = added
    assert event.data["text"].startswith("@person.gone yyy")
    assert len(event.data["text"]) == 255
    assert not {"by", "by_user_id", "by_person"} & set(event.data)
    assert event.data["mentions"] == ["person.gone"]
    assert event.context.user_id is None

    added.clear()
    await store.async_add_comment(task["id"], "no mentions")
    await hass.async_block_till_done()
    assert "mentions" not in added[0].data


async def test_mention_event_once_per_person_never_for_the_author(
    hass: HomeAssistant, hass_ws_client, hass_admin_user, mock_config_entry, store, people
) -> None:
    task = await store.async_add_task("Task")
    mentions = async_capture_events(hass, f"{DOMAIN}_comment_mention")
    client = await hass_ws_client(hass)
    msg = await _call(
        client, "add_comment", list_id=mock_config_entry.entry_id, task_id=task["id"],
        text="<@person.anna> <@person.kevin> <@person.anna> <@person.ben>",
    )
    comment = msg["result"]
    await hass.async_block_till_done()

    assert [e.data["mentioned_person"] for e in mentions] == ["person.anna", "person.ben"]
    event = mentions[0]
    assert event.data["comment_id"] == comment["id"]
    assert event.data["task_id"] == task["id"]
    assert event.data["by"] == hass_admin_user.name
    assert event.data["by_person"] == "person.kevin"
    assert event.data["text"] == "@Anna @Kevin @Anna @Ben"
    assert event.context.user_id == hass_admin_user.id


async def test_edit_fires_mention_only_for_newly_added_persons(
    hass: HomeAssistant, hass_ws_client, mock_config_entry, store, people
) -> None:
    task = await store.async_add_task("Task")
    base = {"list_id": mock_config_entry.entry_id, "task_id": task["id"]}
    client = await hass_ws_client(hass)
    comment = (await _call(client, "add_comment", **base, text="<@person.anna> hi"))["result"]
    await hass.async_block_till_done()

    mentions = async_capture_events(hass, f"{DOMAIN}_comment_mention")
    added = async_capture_events(hass, f"{DOMAIN}_comment_added")
    msg = await _call(
        client, "update_comment", **base, comment_id=comment["id"],
        text="<@person.anna> <@person.ben> hi",
    )
    assert msg["success"]
    await hass.async_block_till_done()
    assert [e.data["mentioned_person"] for e in mentions] == ["person.ben"]
    assert added == []  # an edit is not a new comment

    # Removing and re-adding someone counts as new again; no one new, no event.
    mentions.clear()
    await _call(client, "update_comment", **base, comment_id=comment["id"], text="<@person.ben> hi")
    await hass.async_block_till_done()
    assert mentions == []
    await _call(client, "update_comment", **base, comment_id=comment["id"], text="<@person.anna> <@person.ben>")
    await hass.async_block_till_done()
    assert [e.data["mentioned_person"] for e in mentions] == ["person.anna"]


async def test_commented_history_entry(
    hass: HomeAssistant, hass_ws_client, hass_admin_user, mock_config_entry, store, people
) -> None:
    task = await store.async_add_task("Task")
    client = await hass_ws_client(hass)
    msg = await _call(
        client, "add_comment", list_id=mock_config_entry.entry_id, task_id=task["id"],
        text="<@person.anna> hi",
    )
    entry = store.get_task(task["id"])["history"][-1]
    assert entry["action"] == "commented"
    assert entry["by"] == hass_admin_user.name
    assert entry["mentions"] == ["person.anna"]
    assert entry["comment_id"] == msg["result"]["id"]


async def test_service_add_comment(
    hass: HomeAssistant, hass_admin_user, mock_config_entry, store, people
) -> None:
    task = await store.async_add_task("Water the plants")
    added = async_capture_events(hass, f"{DOMAIN}_comment_added")
    mentions = async_capture_events(hass, f"{DOMAIN}_comment_mention")
    await hass.services.async_call(
        DOMAIN, "add_comment",
        {"list_name": "Test List", "task_title": "Water the plants", "text": "<@person.anna> done?"},
        blocking=True, context=Context(user_id=hass_admin_user.id),
    )
    await hass.async_block_till_done()
    (comment,) = store.get_task(task["id"])["comments"]
    assert comment["text"] == "<@person.anna> done?"
    assert comment["mentions"] == ["person.anna"]
    assert comment["by"] == hass_admin_user.name
    assert comment["by_user_id"] == hass_admin_user.id
    assert comment["by_person"] == "person.kevin"
    assert len(added) == 1 and len(mentions) == 1

    # By task_id, from an automation (no user): no author fields.
    await hass.services.async_call(
        DOMAIN, "add_comment",
        {"entry_id": mock_config_entry.entry_id, "task_id": task["id"], "text": "auto"},
        blocking=True,
    )
    auto = store.get_task(task["id"])["comments"][-1]
    assert (auto["by"], auto["by_user_id"], auto["by_person"]) == (None, None, None)


async def test_service_add_comment_rejects_bad_input(
    hass: HomeAssistant, mock_config_entry, store, people
) -> None:
    from homeassistant.exceptions import ServiceValidationError

    task = await store.async_add_task("Task")
    base = {"list_name": "Test List", "task_id": task["id"]}
    with pytest.raises(ServiceValidationError):
        await hass.services.async_call(DOMAIN, "add_comment", {**base, "text": "<@person.ghost>"}, blocking=True)
    with pytest.raises(ServiceValidationError):
        await hass.services.async_call(DOMAIN, "add_comment", {**base, "text": "  "}, blocking=True)
    assert store.get_task(task["id"])["comments"] == []


async def test_native_move_keeps_comments_and_records_moved(
    hass: HomeAssistant, hass_ws_client, hass_admin_user, mock_config_entry, store, people
) -> None:
    other = MockConfigEntry(domain=DOMAIN, data={"name": "Second List"}, title="Second List")
    other.add_to_hass(hass)
    await hass.config_entries.async_setup(other.entry_id)
    await hass.async_block_till_done()
    other_store = hass.data[DOMAIN][other.entry_id]

    task = await store.async_add_task("Move me")
    await store.async_add_comment(task["id"], "stays with the task", by="Dom")
    client = await hass_ws_client(hass)
    msg = await _call(
        client, "move_task", source_list_id=mock_config_entry.entry_id,
        target_list_id=other.entry_id, task_id=task["id"],
    )
    assert msg["success"]

    moved = other_store.get_task(task["id"])
    assert [c["text"] for c in moved["comments"]] == ["stays with the task"]
    assert moved["history"][-1]["action"] == "moved"
    assert moved["history"][-1]["from_list"] == "Test List"
    assert moved["history"][-1]["by"] == hass_admin_user.name

    # And the cross command records it the same way, moving back.
    msg = await _call(
        client, "move_task_cross", source_list_id=other.entry_id,
        target_list_id=mock_config_entry.entry_id, task_id=task["id"],
    )
    assert msg["success"]
    back = store.get_task(task["id"])
    assert back["history"][-1]["from_list"] == "Second List"
    assert len(back["comments"]) == 1


async def test_failed_move_restores_task_without_moved_entry(
    hass: HomeAssistant, hass_ws_client, mock_config_entry, store, people
) -> None:
    from custom_components.home_tasks import websocket_api as ws

    other = MockConfigEntry(domain=DOMAIN, data={"name": "Second List"}, title="Second List")
    other.add_to_hass(hass)
    await hass.config_entries.async_setup(other.entry_id)
    await hass.async_block_till_done()
    task = await store.async_add_task("Stay")
    await store.async_add_comment(task["id"], "keep me")
    hist_before = [dict(h) for h in store.get_task(task["id"])["history"]]

    other_store = hass.data[DOMAIN][other.entry_id]
    await other_store.async_add_task("Occupies the only slot")
    with patch("custom_components.home_tasks.store.MAX_TASKS_PER_LIST", 1):
        with pytest.raises(ValueError, match="Maximum number of tasks"):
            await ws.async_move_task_any(
                hass, task_id=task["id"], src_list_id=mock_config_entry.entry_id,
                tgt_list_id=other.entry_id,
            )
    restored = store.get_task(task["id"])
    assert restored["history"] == hist_before
    assert len(restored["comments"]) == 1
