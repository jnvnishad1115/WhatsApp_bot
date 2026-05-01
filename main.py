import os
import asyncio
from telethon import TelegramClient, events
from telethon.sessions import StringSession


# ─── Config from environment variables ───────────────────
API_ID         = 30779174
API_HASH       = "d5e27c8c4e30129238716a83df45b1f8"
SESSION_STRING = "1BVtsOGoBu7kTY6aj2tLpZfO9TsSKk4bdkC81il4_XgtSjvBxvdqMA2ydCLruFhwbXuOBMyNVyHj7FNEUyKqI3MtDQRAZdW0wZ2AMSamPrnOiPajxbF0zBSzjT8aqeaNnzfMST05bo8vvlAaK9ln7OWltRXeNGmFmtyyZ76-Xwd2eMgfdQyaqHTfjvKFdP2Haj3npvPXTW1_fAYk6whrnmNqNCOu3ScHOv2hrdj01oi10iGe_ntFlwrPDCzEIJmXurDV_paZXOfHoIkR0lL62Mvc5NuKw9v7k3QdOctrlwxrqO4ymS-MwavED3Azbdr7Hzk2C-RWmD4__dJ7z19aJeOJwYdZ2XKM="
AUTO_REPLY_MESSAGE = os.environ.get(
    "AUTO_REPLY_MSG",
    "👋 Hey! I'm currently unavailable.\nI'll get back to you as soon as possible. 🙏"
)
# ─────────────────────────────────────────────────────────

client = TelegramClient(StringSession(SESSION_STRING), API_ID, API_HASH)

is_active: bool = True


# ── Owner commands (sent by YOU in any chat) ─
@client.on(events.NewMessage(outgoing=True, pattern=r"^/on$"))
async def cmd_on(event):
    global is_active
    is_active = True
    await event.edit("✅ Auto-reply **enabled**.")


@client.on(events.NewMessage(outgoing=True, pattern=r"^/off$"))
async def cmd_off(event):
    global is_active
    is_active = False
    await event.edit("🔴 Auto-reply **disabled**.")


@client.on(events.NewMessage(outgoing=True, pattern=r"^/status$"))
async def cmd_status(event):
    state = "✅ Active" if is_active else "🔴 Inactive"
    await event.edit(f"Auto-reply status: **{state}**")


# ── Incoming private messages ────────────────
@client.on(events.NewMessage(incoming=True, func=lambda e: e.is_private))
async def handle_incoming(event):
    if not is_active:
        return

    await event.reply(AUTO_REPLY_MESSAGE)
    print(f"[Auto-replied] → user {event.sender_id}")


# ── Entry point ──────────────────────────────
async def main():
    await client.start()
    me = await client.get_me()
    print(f"✅ Logged in as: {me.first_name} (@{me.username})")
    print(f"   Auto-reply : {'ON' if is_active else 'OFF'}")
    print("   Running on Railway — no file session needed.")
    await client.run_until_disconnected()


if __name__ == "__main__":
    asyncio.run(main())
