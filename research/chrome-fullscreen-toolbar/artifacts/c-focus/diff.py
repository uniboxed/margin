# Compares two screenshots: pixels changed in the browser toolbar band
# (y<120: tab strip + omnibox) vs in the page area below it.
import sys
from PIL import Image, ImageChops
a, b = Image.open(sys.argv[1]).convert('RGB'), Image.open(sys.argv[2]).convert('RGB')
def changed(box):
    d = ImageChops.difference(a.crop(box), b.crop(box)).convert('L').point(lambda v: 255 if v > 16 else 0)
    return d.histogram()[255]
w, h = a.size
print(f"toolbar(y<88)={changed((0,0,w,88))} below-toolbar(y>=88)={changed((0,88,w,h))}")
