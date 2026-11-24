"""Run in background Blender with the supplied textured studio open. Never saves the source."""
import sys
from pathlib import Path
from collections import defaultdict
import bpy
import bmesh
from mathutils import Matrix, Vector

out = Path(sys.argv[sys.argv.index("--") + 1]).resolve()
if out.suffix != ".glb" or out.parent.name != ".local-vehicle":
    raise ValueError("Choose a GLB path inside .local-vehicle")
out.parent.mkdir(parents=True, exist_ok=True)
compact = "--compact" in sys.argv[sys.argv.index("--") + 2:]
scale = 0.305
scene = bpy.context.scene
source = [o for o in scene.objects if o.type == "MESH" and o.visible_get() and not o.hide_render
          and all(not c.name.startswith("studio") for c in o.users_collection)]
graph = bpy.context.evaluated_depsgraph_get()
print("Selected", len(source), "visible vehicle meshes")

def finish(name, rgb, metal, roughness, coat=0, coat_roughness=0.15):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    for key, value in {"Base Color": (*rgb, 1), "Metallic": metal, "Roughness": roughness,
                       "Coat Weight": coat, "Coat Roughness": coat_roughness, "IOR": 1.48}.items():
        bsdf.inputs[key].default_value = value
    return mat

pearl = finish("Pearl ceramic white", (.37,.37,.35), .18,.31,.78)
black = finish("Obsidian lacquer", (.012,.013,.015), .23,.30,.82,.135)
carbon = finish("Satin carbon composite", (.016,.017,.019), .16,.45)
rubber = finish("Scrubbed slick rubber", (.014,.014,.015), 0,.72)
metal = finish("Machined titanium", (.32,.33,.34), .93,.25)
alloy = finish("Graphite alloy", (.085,.09,.096), .84,.32)
trim = finish("Cockpit upholstery", (.009,.01,.011), 0,.77)

def replacement(name, slot, original):
    if name == "main_body.003":
        return [pearl, carbon, black, black][slot]
    if name == "front_wing_complete":
        return [black, carbon, pearl][slot]
    if name == "rear_wing.001":
        return [black, carbon][slot]
    if name.startswith("rim_"): return alloy if slot == 0 else metal
    if name.startswith("tire_ventil"): return metal
    if name.startswith("tire_"): return rubber
    if name in ("mirror.001","front_wing_side_wings"): return pearl
    if name in ("front_upper_arm","front_lower_arm","steering_rods"): return alloy
    if "stickers" in original or "display" in original or "glass" in original: return black
    if any(token in original.lower() for token in ("chrome","silver","brass","mirror")): return metal
    if "anodized" in original.lower(): return alloy
    if any(token in original.lower() for token in ("rubber","felt","foam","fabric","plastic")): return trim
    return carbon

# Cap subdivisions before evaluating edit-friendly source meshes. Baked parts get a
# silhouette-weighted polygon budget. Small cockpit switches retain their actual profiles.
for o in source:
    for modifier in o.modifiers:
        if modifier.type == "SUBSURF":
            modifier.levels = min(modifier.levels, 2)
graph.update()
counts = {}
for o in source:
    m = o.evaluated_get(graph).data
    counts[o.name] = len(m.loops) - 2 * len(m.polygons)
for o in source:
    n = o.name
    target = 60000 if n == "main_body.003" else 2200
    if n == "rear_wing.001" or n == "front_wing_complete": target = 11500
    if n.startswith("rim_"): target = 11500
    if n in ("tire_front","tire_rear"): target = 8500
    if n.startswith(("steering_wheel","paddle","rear_led","Cylinder.")): target = 720
    if n in ("seat","cockpit_inner","front_wheel_inner_cover","mirror.001"): target = 4200
    if compact:
        target = max(160, int(target * 0.20))
        if n in ("tire_front","tire_rear"): target = 2400
    if counts[n] > target * 1.1:
        dec = o.modifiers.new("Web silhouette budget","DECIMATE")
        dec.ratio = target / counts[n]
graph.update()

# Fixed world orientation: the nose points down X. Find contact height and axle centers
# from evaluated tire vertices. Do not rely on the source's mirror-object origins.
def wheelspec(name):
    obj = bpy.data.objects["tire_"+name].evaluated_get(graph)
    pts = [obj.matrix_world @ v.co for v in obj.data.vertices]
    pts = [p for p in pts if p.y > 0]
    lo = Vector([min(p[i] for p in pts) for i in range(3)])
    hi = Vector([max(p[i] for p in pts) for i in range(3)])
    return (hi+lo)*0.5, (hi.z-lo.z)*0.5
axles = {n: wheelspec(n) for n in ("front","rear")}
ground = min(c.z-r for c,r in axles.values())
basis = Matrix.Translation((-1.60, 0, -ground*scale)) @ Matrix.Scale(scale,4)

batches = defaultdict(list)
for o in source:
    item = o.evaluated_get(graph)
    mesh = bpy.data.meshes.new_from_object(item, depsgraph=graph)
    mesh.transform(basis @ item.matrix_world)
    slots = [replacement(o.name,i,mat.name if mat else "") for i,mat in enumerate(mesh.materials)]
    for i,mat in enumerate(slots): mesh.materials[i] = mat
    if not slots: mesh.materials.append(carbon)
    # Neither UVs, vertex colors nor source shader graphs enter the exported vehicle.
    while mesh.uv_layers: mesh.uv_layers.remove(mesh.uv_layers[0])
    while mesh.color_attributes: mesh.color_attributes.remove(mesh.color_attributes[0])
    axle = None
    if o.name.startswith(("rim_","tire_")): axle = o.name.split("_")[-1]
    if o.name in ("Cylinder.003","Cylinder.004"): axle = "rear"
    if o.name in ("Cylinder.005","Cylinder.006"): axle = "front"
    if axle:
        for sign,side in [(1,"right"),(-1,"left")]:
            half = mesh.copy()
            bm=bmesh.new()
            bm.from_mesh(half)
            bmesh.ops.delete(bm,geom=[v for v in bm.verts if sign*v.co.y < 0],context="VERTS")
            bm.to_mesh(half)
            bm.free()
            batches[(axle,side)].append(half)
        bpy.data.meshes.remove(mesh)
    else:
        batches[("body","")].append(mesh)

# A clean scene and five joined objects remove studio lights, cameras, hidden templates
# and draw calls for individual buttons. Original material boundaries stay intact.
clean = bpy.data.scenes.new("Delta vehicle export")
bpy.context.window.scene = clean
for (axle,side),meshes in batches.items():
    bpy.ops.object.select_all(action="DESELECT")
    center = Vector((0,0,0))
    if side:
        c,r = axles[axle]
        center = basis @ Vector((c.x,c.y if side=="right" else -c.y,c.z))
    for mesh in meshes:
        mesh.transform(Matrix.Translation(-center))
        ob=bpy.data.objects.new("Part",mesh)
        clean.collection.objects.link(ob)
        ob.location=center
        ob.select_set(True)
        bpy.context.view_layer.objects.active=ob
    bpy.ops.object.join()
    merged=bpy.context.object
    merged.name = f"wheel-{axle}-{side}" if side else "Monocoque"
    if side: merged["rollingRadius"] = round(r*scale,7)
    print(merged.name, list(center), len(merged.data.polygons))

bpy.ops.export_scene.gltf(filepath=str(out), export_format="GLB", use_active_scene=True,
    export_texcoords=False,export_normals=True,export_tangents=False,export_animations=False,
    export_extras=True,export_cameras=False,export_lights=False,
    export_draco_mesh_compression_enable=True,export_draco_mesh_compression_level=6,
    export_draco_position_quantization=14,export_draco_normal_quantization=10)
print("Exported",out.stat().st_size,"bytes")
