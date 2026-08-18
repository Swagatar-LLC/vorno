# Microsoft Calendar

**Read [microsoft.md](./microsoft.md) first.** Microsoft OAuth requires the
`MICROSOFT_OAUTH_CLIENT_ID` environment variable and an Entra app registration —
neither is set up by default, and the source cannot authenticate without them.

## config.json

```json
{
  "type": "api",
  "name": "Microsoft Calendar",
  "slug": "microsoft-calendar",
  "provider": "microsoft",
  "icon": "https://outlook.live.com/favicon.ico",
  "tagline": "Events and scheduling in {user's Outlook calendar}",
  "api": {
    "baseUrl": "https://graph.microsoft.com/v1.0/",
    "authType": "oauth",
    "microsoftService": "microsoft-calendar",
    "testEndpoint": { "method": "GET", "path": "me" }
  }
}
```

## Scopes

Vorno's `microsoft-calendar` set: `Calendars.ReadWrite`, `User.Read`, `offline_access`.

| Delegated permission | Grants |
|---|---|
| `Calendars.Read` | Read events in all the user's calendars |
| `Calendars.ReadBasic` | Read events **excluding** body, attachments, and attendee details |
| `Calendars.ReadWrite` | Read, create, update, delete events |
| `Calendars.Read.Shared` | Also read calendars others have shared with the user |
| `Calendars.ReadWrite.Shared` | Also write to shared calendars |

Read-only:

```json
"scopes": [
  "https://graph.microsoft.com/Calendars.Read"
]
```

The `.Shared` variants are a separate grant — **a user who says "I can see my
colleague's calendar in Outlook, why can't you?" needs `Calendars.Read.Shared`.**
That is the most common surprise on this service.

## Authenticate

```
mcp__session__source_microsoft_oauth_trigger({ sourceSlug: "microsoft-calendar" })
```

## permissions.json (Explore mode)

```json
{
  "allowedApiEndpoints": [
    { "method": "GET", "path": ".*", "comment": "All GET requests are read-only" },
    { "method": "POST", "path": "^/me/findMeetingTimes", "comment": "Read-only despite POST" }
  ]
}
```

## Useful endpoints

- `me/calendarView?startDateTime=…&endDateTime=…` — **the right call for "what's on
  my calendar"**: it expands recurring series into instances.
- `me/events` — raw event objects; recurring series come back as one master event,
  not as occurrences.
- `me/calendars` — list calendars.
- `me/findMeetingTimes` (POST) — suggest slots.

## Gotchas

- **`calendarView` vs `events` is the distinction that matters.** Asking `me/events`
  "what do I have Thursday" silently misses every recurring meeting. Use
  `calendarView` with an explicit window.
- **Send the `Prefer: outlook.timezone="America/New_York"` header**, or times come
  back in UTC and every rendered time is wrong by the offset. Record the user's
  time zone in `guide.md`.
- `startDateTime`/`endDateTime` are query parameters on `calendarView`, and are
  required — omitting them is a 400.
- All-day events use date-only boundaries and an `isAllDay` flag; do not format
  them as midnight timestamps.
- Room and resource calendars are separate mailboxes and need their own permissions.

---

_Verified 2026-08-17 against Microsoft Graph permissions reference and Vorno's
`MICROSOFT_SERVICE_SCOPES`._
