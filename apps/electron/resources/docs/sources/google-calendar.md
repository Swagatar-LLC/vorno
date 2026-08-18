# Google Calendar

**Read [google.md](./google.md) first** — the OAuth client, the console walkthrough,
and the 7-day refresh-token trap are shared across all Google services.

Enable the **Google Calendar API** in the Google Cloud project.

## config.json

```json
{
  "type": "api",
  "name": "Google Calendar",
  "slug": "google-calendar",
  "provider": "google",
  "icon": "https://calendar.google.com/googlecalendar/images/favicons_2020q4/calendar_31.ico",
  "tagline": "Events and scheduling for {user's calendar}",
  "api": {
    "baseUrl": "https://www.googleapis.com/calendar/v3/",
    "authType": "oauth",
    "googleService": "calendar",
    "googleOAuthClientId": "….apps.googleusercontent.com",
    "googleOAuthClientSecret": "GOCSPX-…",
    "testEndpoint": { "method": "GET", "path": "users/me/calendarList" }
  }
}
```

## Scopes

Vorno's `googleService: "calendar"` default is the **full** `calendar` scope. Narrow
it whenever the user did not ask for write access:

| Scope | Grants |
|---|---|
| `https://www.googleapis.com/auth/calendar` | Full read/write on all calendars |
| `https://www.googleapis.com/auth/calendar.readonly` | See and download any accessible calendar |
| `https://www.googleapis.com/auth/calendar.events` | Read/write events only, not calendar settings |
| `https://www.googleapis.com/auth/calendar.events.readonly` | View events on all calendars |
| `https://www.googleapis.com/auth/calendar.calendarlist.readonly` | Just the list of subscribed calendars |
| `https://www.googleapis.com/auth/calendar.settings.readonly` | Calendar settings (including time zone) |

Read-only:

```json
"googleScopes": [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/userinfo.email"
]
```

For "let me create events but don't touch my calendar configuration", use
`calendar.events` — a genuinely useful middle rung people usually skip.

## Authenticate

```
mcp__session__source_google_oauth_trigger({ sourceSlug: "google-calendar" })
```

## permissions.json (Explore mode)

```json
{
  "allowedApiEndpoints": [
    { "method": "GET", "path": ".*", "comment": "All GET requests are read-only" }
  ]
}
```

## Gotchas

- **Time zones are the failure mode here.** Events return `start.dateTime` with an
  offset, or `start.date` for all-day events — two different shapes. Ask for
  `timeZone` explicitly on list calls, and record the user's time zone in `guide.md`
  so future sessions do not have to re-derive it.
- `calendarId` is `primary` for the user's own calendar. Other calendars need the
  ID from `calendarList`, not the display name.
- Recurring events return the series unless you pass `singleEvents=true`, in which
  case you get expanded instances. Which one is correct depends on the question —
  "what's on my calendar Thursday" wants expanded instances.
- If the user also wants Gmail, reuse the same Cloud project and client ID; just
  enable the Calendar API too.

---

_Verified 2026-08-17 against Google's OAuth 2.0 scope reference and Vorno's
`GOOGLE_SERVICE_SCOPES`._
