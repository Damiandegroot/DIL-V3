# Access & Roles Setup (Supabase + Vercel)

## 1) Configure frontend auth

Edit `config.js`:

```js
window.RED_SYNC_CONFIG = {
  supabaseUrl: "https://YOUR-PROJECT-REF.supabase.co",
  supabaseAnonKey: "YOUR_SUPABASE_ANON_KEY",
};
```

`supabaseAnonKey` is public-safe for frontend use.

## 2) Configure Vercel server env vars

In Vercel project settings, add:

- `OPENAI_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_INVITE_REDIRECT_URL` (example: `https://your-app.vercel.app`)

## 3) Make your first supervisor

In Supabase dashboard:

1. Create/sign in one user account.
2. Open that user.
3. Set `user_metadata.role = "supervisor"` (or `app_metadata.role = "supervisor"`).
4. Save.

Now this user can open **Notifications -> User Access** and send invites.

## 4) Invite flow

Supervisor enters:
- email
- role (`sales_rep` or `supervisor`)
- optional full name + department

The app calls `/api/invite-user`, which verifies the caller is supervisor and sends the invite email via Supabase Auth Admin API.

## 5) Role behavior in app

- `sales_rep`: dashboard + create + archive
- `supervisor`: full access (meeting, analytics, notifications, edit actions)

Role comes from Supabase metadata and is no longer manually changed when auth is configured.
