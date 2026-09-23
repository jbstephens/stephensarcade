# Sample real elevation for the PoCo course area from AWS terrarium tiles (USGS 3DEP).
import math, io, urllib.request
from PIL import Image

Z = 15
cache = {}
def tile(z, x, y):
    if (z, x, y) not in cache:
        url = f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
        req = urllib.request.Request(url, headers={"User-Agent": "stephens-arcade-dev"})
        with urllib.request.urlopen(req, timeout=30) as r:
            cache[(z, x, y)] = Image.open(io.BytesIO(r.read())).convert("RGB")
    return cache[(z, x, y)]

def elev(lat, lon):
    n = 2 ** Z
    xf = (lon + 180.0) / 360.0 * n
    lr = math.radians(lat)
    yf = (1.0 - math.log(math.tan(lr) + 1 / math.cos(lr)) / math.pi) / 2.0 * n
    tx, ty = int(xf), int(yf)
    px = min(255, int((xf - tx) * 256)); py = min(255, int((yf - ty) * 256))
    r, g, b = tile(Z, tx, ty).getpixel((px, py))
    return (r * 256 + g + b / 256) - 32768

# Grid over course area
LAT_N, LAT_S, LON_W, LON_E = 37.9515, 37.9360, -122.0820, -122.0580
ROWS, COLS = 11, 13
print("ELEVATION GRID (m), NW corner top-left, ~%dm x %dm cells" % (
    111320 * math.cos(math.radians(37.944)) * (LON_E - LON_W) / (COLS - 1),
    110540 * (LAT_N - LAT_S) / (ROWS - 1)))
for i in range(ROWS):
    lat = LAT_N + (LAT_S - LAT_N) * i / (ROWS - 1)
    row = []
    for j in range(COLS):
        lon = LON_W + (LON_E - LON_W) * j / (COLS - 1)
        row.append(f"{elev(lat, lon):5.1f}")
    print(" ".join(row))

pts = {
    "PH Park lawn": (37.9494, -122.0660),
    "PH Park pool": (37.94885, -122.0655),
    "Sequoia Elem": (37.9441, -122.0688),
    "Sequoia Middle": (37.9444, -122.0667),
    "Soule/Hubbard": (37.9427, -122.0705),
    "Canal @ Boyd": (37.9435, -122.0813),
    "Canal mid": (37.9466, -122.0808),
    "Murderers Ck @ Beatrice": (37.9420, -122.0707),
    "Pleasant Oaks Park": (37.9372, -122.0690),
    "PH Middle": (37.9374, -122.0659),
    "Soldier's Memorial Pk": (37.9432, -122.0608),
    "City Hall": (37.9475, -122.0635),
    "Downtown/Crossroads": (37.9434, -122.0575),
    "Christ the King": (37.9470, -122.0782),
    "Oak Park Blvd @ canal": (37.9385, -122.0760),
}
print("\nKEY POINTS:")
for k, (la, lo) in pts.items():
    print(f"  {k:26s} {elev(la, lo):6.1f} m")
