"""Unit tests for task comments, mentions and the richer history entries."""
from __future__ import annotations

import pytest
from homeassistant.core import HomeAssistant

from custom_components.home_tasks.const import (
    MAX_COMMENT_LENGTH,
    MAX_COMMENTS_PER_TASK,
    MAX_MENTIONS_PER_COMMENT,
)
from custom_components.home_tasks.store import TooManyMentionsError, extract_mentions

pytestmark = pytest.mark.unit


def test_extract_mentions_unique_in_order_of_first_appearance() -> None:
    text = "<@person.anna> hi <@person.ben_2> and again <@person.anna> then <@person.cy>"
    assert extract_mentions(text) == ["person.anna", "person.ben_2", "person.cy"]


@pytest.mark.parametrize(
    "text",
    ["", "no tokens", "@person.anna", "<@light.kitchen>", "<@person.Anna>", "<@person.>", "< @person.anna>"],
)
def test_extract_mentions_ignores_junk(text: str) -> None:
    assert extract_mentions(text) == []


async def test_new_and_duplicated_tasks_start_without_comments(hass: HomeAssistant, store) -> None:
    task = await store.async_add_task("Plain")
    assert task["comments"] == []
    await store.async_add_comment(task["id"], "note")
    copy = await store.async_duplicate_task(task["id"])
    assert copy["comments"] == []
    assert len(store.get_task(task["id"])["comments"]) == 1


async def test_load_backfills_comments(hass: HomeAssistant, store) -> None:
    task = await store.async_add_task("Old task")
    del task["comments"]
    store._backfill_recurrence_fields()
    assert task["comments"] == []


async def test_add_comment_stores_fields_and_history(hass: HomeAssistant, store) -> None:
    task = await store.async_add_task("Task")
    comment = await store.async_add_comment(
        task["id"], "  Hi <@person.anna> and <@person.anna>  ",
        by="Dom", by_user_id="u1", by_person="person.dom",
    )
    assert comment["text"] == "Hi <@person.anna> and <@person.anna>"
    assert comment["mentions"] == ["person.anna"]
    assert (comment["by"], comment["by_user_id"], comment["by_person"]) == ("Dom", "u1", "person.dom")
    assert "edited_ts" not in comment
    assert store.get_task(task["id"])["comments"] == [comment]
    assert store.get_task(task["id"])["history"][-1] == {
        "ts": comment["ts"], "action": "commented", "comment_id": comment["id"],
        "by": "Dom", "mentions": ["person.anna"],
    }


async def test_add_comment_without_mentions_or_author(hass: HomeAssistant, store) -> None:
    task = await store.async_add_task("Task")
    comment = await store.async_add_comment(task["id"], "plain")
    assert (comment["by"], comment["by_user_id"], comment["by_person"]) == (None, None, None)
    entry = store.get_task(task["id"])["history"][-1]
    assert entry["action"] == "commented"
    assert "mentions" not in entry and "by" not in entry


@pytest.mark.parametrize("text", ["", "   ", "x" * (MAX_COMMENT_LENGTH + 1)])
async def test_add_comment_rejects_bad_text(hass: HomeAssistant, store, text: str) -> None:
    task = await store.async_add_task("Task")
    with pytest.raises(ValueError):
        await store.async_add_comment(task["id"], text)
    assert store.get_task(task["id"])["comments"] == []


async def test_add_comment_limits(hass: HomeAssistant, store) -> None:
    task = await store.async_add_task("Task")
    await store.async_add_comment(task["id"], "x" * MAX_COMMENT_LENGTH)
    many = " ".join(f"<@person.p{i}>" for i in range(MAX_MENTIONS_PER_COMMENT + 1))
    with pytest.raises(TooManyMentionsError):
        await store.async_add_comment(task["id"], many)
    ok = " ".join(f"<@person.p{i}>" for i in range(MAX_MENTIONS_PER_COMMENT))
    await store.async_add_comment(task["id"], ok)
    # The same person repeated is still one mention.
    await store.async_add_comment(task["id"], "<@person.a> " * 30)

    task["comments"] = task["comments"][:1] * MAX_COMMENTS_PER_TASK
    with pytest.raises(ValueError, match="Maximum number of comments"):
        await store.async_add_comment(task["id"], "one too many")


async def test_unknown_task_raises(hass: HomeAssistant, store) -> None:
    with pytest.raises(ValueError):
        await store.async_add_comment("nope", "text")


async def test_update_comment_recomputes_mentions_and_reports_added(hass: HomeAssistant, store) -> None:
    task = await store.async_add_task("Task")
    comment = await store.async_add_comment(
        task["id"], "<@person.anna> hi", by="Dom", by_user_id="u1"
    )
    seen: list = []
    store.on_comment_updated = lambda t, c, added: seen.append((c["id"], added))
    hist_len = len(store.get_task(task["id"])["history"])

    updated = await store.async_update_comment(
        task["id"], comment["id"], "<@person.ben> <@person.anna> hi", user_id="u1", is_admin=False
    )
    assert updated["mentions"] == ["person.ben", "person.anna"]
    assert updated["edited_ts"]
    assert seen == [(comment["id"], ["person.ben"])]
    # Edits add no history entry.
    assert len(store.get_task(task["id"])["history"]) == hist_len


async def test_comment_permissions(hass: HomeAssistant, store) -> None:
    task = await store.async_add_task("Task")
    comment = await store.async_add_comment(task["id"], "mine", by_user_id="author")
    anonymous = await store.async_add_comment(task["id"], "from an automation")

    for user_id in ("other", None):
        with pytest.raises(PermissionError):
            await store.async_update_comment(task["id"], comment["id"], "x", user_id=user_id, is_admin=False)
        with pytest.raises(PermissionError):
            await store.async_delete_comment(task["id"], comment["id"], user_id=user_id, is_admin=False)
    # Without an author id nobody but an admin matches.
    with pytest.raises(PermissionError):
        await store.async_update_comment(task["id"], anonymous["id"], "x", user_id=None, is_admin=False)

    await store.async_update_comment(task["id"], comment["id"], "admin edit", user_id="admin", is_admin=True)
    await store.async_delete_comment(task["id"], comment["id"], user_id="author", is_admin=False)
    await store.async_delete_comment(task["id"], anonymous["id"], user_id="admin", is_admin=True)
    assert store.get_task(task["id"])["comments"] == []
    with pytest.raises(ValueError, match="Comment not found"):
        await store.async_delete_comment(task["id"], comment["id"], user_id="author", is_admin=True)


async def test_section_change_history(hass: HomeAssistant, store) -> None:
    section = await store.async_add_section("Doing")
    task = await store.async_add_task("Task")
    await store.async_update_task(task["id"], actor="Dom", section_id=section["id"])
    await store.async_update_task(task["id"], actor="Dom", section_id=section["id"])  # no change
    await store.async_update_task(task["id"], actor="Dom", section_id=None)
    entries = [h for h in store.get_task(task["id"])["history"] if h.get("field") == "section_id"]
    assert [(e["from"], e["to"], e["by"]) for e in entries] == [
        (None, section["id"], "Dom"), (section["id"], None, "Dom"),
    ]
    assert all(e["action"] == "updated" for e in entries)


async def test_sub_task_history(hass: HomeAssistant, store) -> None:
    task = await store.async_add_task("Task")
    sub = await store.async_add_sub_task(task["id"], "Step", actor="Dom")
    await store.async_update_sub_task(task["id"], sub["id"], actor="Dom", title="Step 1")  # rename
    await store.async_update_sub_task(task["id"], sub["id"], actor="Dom", completed=True)
    await store.async_update_sub_task(task["id"], sub["id"], actor="Dom", completed=True)  # no change
    await store.async_update_sub_task(task["id"], sub["id"], actor="Dom", completed=False)
    await store.async_delete_sub_task(task["id"], sub["id"], actor="Dom")
    entries = [h for h in store.get_task(task["id"])["history"] if h["action"] == "sub_task"]
    assert [(e["op"], e["title"], e["by"]) for e in entries] == [
        ("added", "Step", "Dom"),
        ("completed", "Step 1", "Dom"),
        ("reopened", "Step 1", "Dom"),
        ("deleted", "Step 1", "Dom"),
    ]


async def test_sub_task_history_without_actor(hass: HomeAssistant, store) -> None:
    task = await store.async_add_task("Task")
    await store.async_add_sub_task(task["id"], "Step")
    entry = store.get_task(task["id"])["history"][-1]
    assert entry["op"] == "added" and "by" not in entry
