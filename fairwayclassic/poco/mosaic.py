# Build aerial mosaics of Poets Corner from Esri World Imagery tiles.
import math, io, urllib.request, sys
from PIL import Image

def tile_xy(lat, lon, z):
    n = 2 ** z
    x = (lon + 180.0) / 360.0 * n
    lr = math.radians(lat)
    y = (1.0 - math.log(math.tan(lr) + 1 / math.cos(lr)) / math.pi) / 2.0 * n
    return x, y

def fetch(z, x, y):
    url = f"https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
    req = urllib.request.Request(url, headers={"User-Agent": "stephens-arcade-dev"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return Image.open(io.BytesIO(r.read())).convert("RGB")
        except Exception as e:
            if attempt == 2:
                print(f"FAIL {z}/{x}/{y}: {e}")
                return Image.new("RGB", (256, 256), (30, 30, 30))

def mosaic(name, lat_n, lat_s, lon_w, lon_e, z):
    x0f, y0f = tile_xy(lat_n, lon_w, z)
    x1f, y1f = tile_xy(lat_s, lon_e, z)
    x0, y0, x1, y1 = int(x0f), int(y0f), int(x1f), int(y1f)
    cols, rows = x1 - x0 + 1, y1 - y0 + 1
    print(f"{name}: z{z} {cols}x{rows} = {cols*rows} tiles -> {cols*256}x{rows*256}px")
    img = Image.new("RGB", (cols * 256, rows * 256))
    for ty in range(y0, y1 + 1):
        for tx in range(x0, x1 + 1):
            img.paste(fetch(z, tx, ty), ((tx - x0) * 256, (ty - y0) * 256))
    img.save(name, quality=88)
    # print corner geo-refs for later georegistration
    print(f"  NW corner tile ({x0},{y0}) covers from lon {x0/2**z*360-180:.6f} lat_edge_calcs_in_code")
    return (x0, y0, cols, rows)

if __name__ == "__main__":
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    if which in ("all", "main"):
        # Whole PoCo course candidate area
        mosaic("aerial_main_z17.jpg", 37.9515, 37.9360, -122.0820, -122.0580, 17)
    if which in ("all", "crops"):
        # Close-ups z19: (name, center_lat, center_lon, half_deg_lat, half_deg_lon)
        crops = [
            ("crop_phpark.jpg", 37.94900, -122.06580),   # Pleasant Hill Park + rec + pool
            ("crop_sequoia.jpg", 37.94420, -122.06780),  # Sequoia Elem + Middle campuses
            ("crop_soule.jpg", 37.94330, -122.07050),    # Soule/Hubbard/Beatrice blocks
            ("crop_canal.jpg", 37.94650, -122.08050),    # Canal + trail mid-neighborhood
            ("crop_pleasantoaks.jpg", 37.93720, -122.06900),  # Pleasant Oaks Park + PH Middle
            ("crop_murderers.jpg", 37.94250, -122.07050), # Murderers Creek through blocks
            ("crop_poets_south.jpg", 37.93900, -122.07300), # Byron/Shelly/Masefield area
        ]
        d = 0.0016
        for nm, la, lo in crops:
            mosaic(nm, la + d, la - d, lo - d / 0.79, lo + d / 0.79, 19)
