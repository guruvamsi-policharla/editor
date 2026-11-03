#!/usr/bin/env python3
"""Generate every icon the build ships from icon.svg. See README.md.

Usage: python3 branding/gen-icons.py [--vscodium DIR]
  --vscodium DIR  VSCodium checkout at the pin in fork/upstream.env, for the language document icons
                  (default: fetch it into a temp dir).
Needs cairosvg and Pillow (pip install --user -r branding/requirements.txt).
Output: branding/generated/ (these icons plus branding/static/), laid out like VSCodium's src/stable/,
which fork/scripts/prepare-vscodium.sh copies it over.
"""
import argparse
import io
import re
import shutil
import struct
import subprocess
import tempfile
from pathlib import Path

import cairosvg
from PIL import Image

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
OUT = HERE / 'generated'
RES = OUT / 'resources'
MEDIA = OUT / 'src/vs/workbench/browser'

ICON_SVG = (HERE / 'icon.svg').read_text().strip()
# The mark without its background square: the two lines and the cursor.
MARK = re.sub(r'^<svg[^>]*><rect [^>]*/>|</svg>$', '', ICON_SVG).strip()
BACKGROUND = '#17181B'


def render(size):
	png = cairosvg.svg2png(bytestring=ICON_SVG.encode(), output_width=size, output_height=size)
	return Image.open(io.BytesIO(png)).convert('RGBA')


def png_bytes(image):
	buffer = io.BytesIO()
	image.save(buffer, 'PNG', optimize=True)
	return buffer.getvalue()


def save_png(image, path):
	path.parent.mkdir(parents=True, exist_ok=True)
	image.save(path, 'PNG', optimize=True)


def write_icns(path, images):
	"""images: {OSType: RGBA image}. Every entry is PNG data, which macOS reads for all these types."""
	entries = b''
	for ostype, image in images.items():
		data = png_bytes(image)
		entries += ostype.encode() + struct.pack('>I', len(data) + 8) + data
	path.parent.mkdir(parents=True, exist_ok=True)
	path.write_bytes(b'icns' + struct.pack('>I', len(entries) + 8) + entries)


def write_ico(path, images):
	"""images: one RGBA image per size, largest first."""
	path.parent.mkdir(parents=True, exist_ok=True)
	images[0].save(path, 'ICO', sizes=[i.size for i in images], append_images=images[1:])


def write_xpm(path, image):
	"""Pillow reads XPM but can't write it. Colors are quantized to fit one character per pixel."""
	chars = '.#abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
	alpha = image.getchannel('A').point(lambda a: 255 if a >= 128 else 0)
	indexed = image.convert('RGB').quantize(colors=len(chars), dither=Image.Dither.NONE)
	palette = indexed.getpalette()
	used = len(palette) // 3
	width, height = image.size
	lines = [f'"{width} {height} {used + 1} 1 "', '"  c None"']
	lines += [f'"{c} c #{palette[i * 3]:02X}{palette[i * 3 + 1]:02X}{palette[i * 3 + 2]:02X}"' for i, c in enumerate(chars[:used])]
	pixels, mask = indexed.load(), alpha.load()
	for y in range(height):
		row = ''.join(chars[pixels[x, y]] if mask[x, y] else ' ' for x in range(width))
		lines.append(f'"{row}"')
	path.parent.mkdir(parents=True, exist_ok=True)
	path.write_text('/* XPM */\nstatic char *code[] = {\n' + ',\n'.join(lines) + '\n};\n')


def on_canvas(size, background, logo_size, offset=None):
	canvas = Image.new('RGBA', size, background)
	logo = render(logo_size)
	if offset is None:
		offset = ((size[0] - logo_size) // 2, (size[1] - logo_size) // 2)
	canvas.alpha_composite(logo, offset)
	return canvas


def macos_app_icon(size):
	# Apple's grid: the shape takes 824/1024 of the canvas, the rest stays transparent.
	return on_canvas((size, size), (0, 0, 0, 0), round(size * 824 / 1024))


def darwin_main():
	write_icns(RES / 'darwin/code.icns', {
		'icp4': macos_app_icon(16), 'icp5': macos_app_icon(32),
		'ic07': macos_app_icon(128), 'ic08': macos_app_icon(256),
		'ic09': macos_app_icon(512), 'ic10': macos_app_icon(1024),
		'ic11': macos_app_icon(32), 'ic12': macos_app_icon(64),
		'ic13': macos_app_icon(256), 'ic14': macos_app_icon(512),
	})


def document_badge(size, border):
	"""The icon on a white rounded backing, so it reads on the page and hides VSCodium's mark."""
	backing = Image.new('RGBA', (size, size), (0, 0, 0, 0))
	svg = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="128" fill="#FFFFFF"/></svg>'
	white = Image.open(io.BytesIO(cairosvg.svg2png(bytestring=svg.encode(), output_width=size, output_height=size))).convert('RGBA')
	backing.alpha_composite(white)
	backing.alpha_composite(render(size - 2 * border), (border, border))
	return backing


def document_icons(vscodium):
	"""VSCodium's document icons keep their language art; our icon replaces VSCodium's corner mark."""
	for source in sorted((vscodium / 'src/stable/resources/darwin').glob('*.icns')):
		if source.stem == 'code':
			continue
		base = Image.open(source)
		base.size = (512, 512)
		base.load()
		page = base.convert('RGBA')
		page.alpha_composite(document_badge(156, 8), (346, 356))
		write_icns(RES / 'darwin' / source.name, {
			'ic09': page,
			'ic08': page.resize((256, 256), Image.Resampling.LANCZOS),
			'ic07': page.resize((128, 128), Image.Resampling.LANCZOS),
		})
	for source in sorted((vscodium / 'src/stable/resources/win32').glob('*.ico')):
		if source.stem == 'code':
			continue
		base = Image.open(source)
		base.size = (256, 256)
		base.load()
		page = base.convert('RGBA')
		# VSCodium's logo sits at +150+185 at 64 px, on the page color.
		page.alpha_composite(on_canvas((68, 68), '#F5F6F7', 64), (148, 183))
		sizes = (256, 128, 96, 64, 48, 32, 24, 20, 16)
		write_ico(RES / 'win32' / source.name, [page.resize((s, s), Image.Resampling.LANCZOS) for s in sizes])


def linux():
	save_png(render(1024), RES / 'linux/code.png')
	(RES / 'linux/code.svg').write_text(ICON_SVG + '\n')
	write_xpm(RES / 'linux/rpm/code.xpm', render(256))


def server():
	save_png(render(192), RES / 'server/code-192.png')
	save_png(render(512), RES / 'server/code-512.png')
	write_ico(RES / 'server/favicon.ico', [render(s) for s in (64, 48, 32, 24, 16)])


def windows():
	write_ico(RES / 'win32/code.ico', [render(s) for s in (256, 128, 96, 64, 48, 40, 32, 24, 20, 16)])
	clear = (0, 0, 0, 0)
	save_png(on_canvas((70, 70), clear, 45), RES / 'win32/code_70x70.png')
	save_png(on_canvas((150, 150), clear, 64, (43, 25)), RES / 'win32/code_150x150.png')
	# Installer wizard images, sizes as in VSCodium's icons/build_icons.sh.
	wizard = {
		'big-100': (164, 314, 126), 'big-125': (192, 386, 147), 'big-150': (246, 459, 190),
		'big-175': (273, 556, 211), 'big-200': (328, 604, 255), 'big-225': (355, 700, 273),
		'big-250': (410, 797, 317), 'small-100': (55, 55, 44), 'small-125': (64, 68, 52),
		'small-150': (83, 80, 63), 'small-175': (92, 97, 76), 'small-200': (110, 106, 86),
		'small-225': (119, 123, 103), 'small-250': (138, 140, 116),
	}
	for name, (width, height, logo) in wizard.items():
		on_canvas((width, height), '#FFFFFF', logo).convert('RGB').save(RES / f'win32/inno-{name}.bmp')


def media():
	icon = ICON_SVG.replace('<svg ', '<svg width="1024" height="1024" ', 1)
	(MEDIA / 'media').mkdir(parents=True, exist_ok=True)
	(MEDIA / 'media/code-icon.svg').write_text(icon + '\n')
	# The empty-editor watermark: the mark alone in one flat tone per theme. Same colors as upstream's.
	letterpress = {'dark': ('#B2B2B2', ' fill-opacity="0.3"'), 'light': ('#B2B2B2', ' fill-opacity="0.1"'), 'hcDark': ('#3C3C3C', ''), 'hcLight': ('#B2B2B2', '')}
	(MEDIA / 'parts/editor/media').mkdir(parents=True, exist_ok=True)
	for theme, (fill, opacity) in letterpress.items():
		flat = re.sub(r' (fill|opacity)="[^"]*"', '', MARK)
		svg = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="116 125 300 300"><g fill="{fill}"{opacity}>{flat}</g></svg>\n'
		(MEDIA / f'parts/editor/media/letterpress-{theme}.svg').write_text(svg)


def fetch_vscodium(directory):
	env = dict(re.findall(r'^(\w+)="([^"]*)"', (ROOT / 'fork/upstream.env').read_text(), re.M))
	subprocess.run(['git', 'init', '-q', directory], check=True)
	subprocess.run(['git', '-C', directory, 'fetch', '-q', '--depth', '1', env['VSCODIUM_REPO'], env['VSCODIUM_REF']], check=True)
	subprocess.run(['git', '-C', directory, 'checkout', '-q', 'FETCH_HEAD'], check=True)


def main():
	parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	parser.add_argument('--vscodium', type=Path)
	args = parser.parse_args()
	shutil.rmtree(OUT, ignore_errors=True)
	shutil.copytree(HERE / 'static', OUT)
	darwin_main()
	linux()
	server()
	windows()
	media()
	if args.vscodium:
		document_icons(args.vscodium)
	else:
		with tempfile.TemporaryDirectory() as directory:
			fetch_vscodium(directory)
			document_icons(Path(directory))


if __name__ == '__main__':
	main()
