# Axis F1 Telemetry Laboratory

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

The control-room sculpture uses a fixed hero angle, damped cursor parallax, reduced-motion support, and a local WebP fallback. Each circuit schematic uses independently projected venue coordinates. Geographic provenance and license terms are in [the circuit data credits](public/licenses/circuits.txt).

Studio sound controls the synthesized navigation, interaction, and transition effects. Mute and volume preferences are saved locally.

The detailed car is adapted from Peter Kiss?s (peterkissdesign) [F1 2022 Concept car](https://www.cgtrader.com/free-3d-models/car/racing-car/f1-2022-concept-car), used with the creator?s permission for this public, noncommercial Axis F1 portfolio.

The source scene stays intact. To regenerate the optimized local mesh with Blender 4.3, run this from the frontend directory, then restart Vite.

```powershell
blender -b --factory-startup -Y f1_2022_textured_studio.blend --python-exit-code 1 --python tools/export_vehicle.py -- .local-vehicle/vehicle.glb
blender -b --factory-startup -Y f1_2022_textured_studio.blend --python-exit-code 1 --python tools/export_vehicle.py -- .local-vehicle/vehicle-compact.glb --compact
```

The homepage opens directly in the animated hybrid view. For the standalone photograph, open `/studio-still.html` in the local preview. It freezes the vehicle and camera and accumulates 384 samples per pixel using five bounces. The animated hero uses cached studio reflections and shadows and drops postprocessing under sustained frame pressure.
