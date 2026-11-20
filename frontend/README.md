# Delta F1 Telemetry Laboratory

From the repository root, start the existing FastAPI service in one PowerShell terminal.

```powershell
.\.venv\Scripts\python.exe -m uvicorn src.api.main:app --host 127.0.0.1 --port 8000
```

Start the frontend in a second terminal with Node.js 22 and npm.

```powershell
cd frontend
npm.cmd ci
npm.cmd run dev
```

Open the local URL printed by Vite. Select a qualifying session, choose two eligible laps, then select **Compare laps**. Hover over a trace or use the lap-progress slider and arrow keys to inspect all four channels together.

The dev and preview servers proxy `/api` to `http://127.0.0.1:8000`. To use another local FastAPI port, set `$env:DELTA_API_ORIGIN` before starting Vite. The API reads its existing server-side database configuration.

`npm.cmd run build` type-checks the frontend and creates the production bundle in `dist`. Use `npm.cmd run preview` to serve that bundle locally.

The control-room sculpture has pointer and keyboard orbit, a Home-key camera reset, reduced-motion support, and a local WebP fallback. Each circuit schematic uses independently projected venue coordinates. Geographic provenance and license terms are in [the circuit data credits](public/licenses/circuits.txt).

