# ADR-0026: three-dimensional evidence view

Status: accepted. Date: 2026-09-07.

The owner requested a 3D graph space in place of the fixed-column SVG dashboard.
Use a locally bundled, lazily loaded Three.js scene and OrbitControls. Keep React
provided by the pinned Hermes dashboard SDK. The build pins Three.js 0.180.0 and
esbuild 0.25.10; Docker builds the renderer alongside the native dashboard assets.

Use deterministic bounded spring coordinates for the current graph page. These
coordinates are presentation only, never stored facts or inferred relationships.
Continue consuming the existing scoped graph/source APIs and export their original
JSON unchanged. No graph database, model calls, CDN, provider or guard changes.

The scene supports orbit, pan, zoom, focus and optional full screen. A searchable
keyboard-accessible node browser and evidence inspector remain available without
WebGL. Distinguish generated/citation links from observations. Render on demand,
cap device pixel ratio, and dispose controls, observers and GPU resources when
changing page/scope or leaving the graph. Never auto-rotate the scene.
