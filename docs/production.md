# Axis F1 production setup

## Supabase changes for the owner to review

The app uses PostgreSQL directly. Check Integrations → Data API in Supabase and record whether it is enabled and whether the exposed schemas include public. The gateway answered 401 without an API key. This alone cannot establish table accessibility. The privilege audit found schema USAGE for anon, RLS disabled on all six public tables, and read and write grants for both anon and authenticated. The current database login can write, create roles and bypass RLS.

If this project has no other REST or GraphQL clients, disable the Data API. Otherwise remove public from its exposed schemas if possible. Review dependencies before revoking privileges. Enable RLS on the six tables and limit reads to the backend role. If other users or import jobs depend on access, design their policies separately. Keep the existing importer credential separate.

Proposed SQL for a database owner to review and execute **only after approval**, in a transaction:

```sql
BEGIN;
CREATE ROLE axis_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
GRANT CONNECT ON DATABASE postgres TO axis_reader;
GRANT USAGE ON SCHEMA public TO axis_reader;
GRANT SELECT ON public.drivers, public.events, public.sessions, public.session_entries,
                public.laps, public.telemetry_samples TO axis_reader;
ALTER ROLE axis_reader SET default_transaction_read_only = on;

DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['drivers','events','sessions','session_entries','laps','telemetry_samples']
  LOOP
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM PUBLIC, anon, authenticated', tbl);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('CREATE POLICY axis_reader_select ON public.%I FOR SELECT TO axis_reader USING (true)', tbl);
  END LOOP;
END $$;
COMMIT;
```

Set the password privately using the interactive psql command `\password axis_reader`. Check effective grants, inherited PUBLIC privileges, callable SECURITY DEFINER routines, and default privileges of each table-creating role before launch. Confirm the new role can read all six tables and has no table writes or schema CREATE permission. Verify existing import access independently. After approval, use Supabase Connect → Transaction pooler, substitute the custom role in the pooler username, and URL-encode the password. The request-scoped connections use TLS, bounded connection and statement times, and disabled prepared statements.

## Vercel

Import gjones01/AXIS-F1 as one project with Root Directory set to the repository root. Keep the two services and ordered rewrites from vercel.json. Set DATABASE_URL as Sensitive for Production. Only give trusted previews database access, preferably with a separate read-only credential. Example value:

```text
postgresql://axis_reader.<project-ref>:<encoded-password>@<transaction-pooler-host>:6543/postgres?sslmode=require
```

No frontend environment variable is required. Same-origin fetches work on both the Vercel hostname and the eventual custom domain. The root pyproject.toml supplies API runtime dependencies. requirements.txt remains the local development and import dependency list.

Before opening public access, configure a Vercel Firewall rate-limit rule for POST /api/compare keyed by client IP, for example 20 requests per minute with HTTP 429. Tune it against actual traffic and check plan allowance and cost before enabling. Consider a higher limit on GET /api/* if catalog traffic puts pressure on the pool. Confirm the regional function bundle size in the linked production build. Both detailed car variants and their reveal posters ship as frontend static assets.

Once the prepared files are on the deployment branch and launch is approved, check /api/health, /api/sessions and a real comparison on the generated Vercel hostname first. Then add axisf1.app in Project Settings → Domains and use the exact DNS record Vercel displays at Namecheap.
