#!/usr/bin/env python3
"""Create a real example-plugin ZIP in Scratch; publish it through the normal release CLI."""
import argparse
import hashlib
from pathlib import Path
import re
import zipfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--version', required=True)
parser.add_argument('--output', required=True, type=Path)
args = parser.parse_args()
if not re.fullmatch(r'\d+\.\d+\.\d+', args.version):
    parser.error('version must be a numeric X.Y.Z')
if not Path('/Volumes/Scratch').is_dir():
    parser.error('/Volumes/Scratch is not mounted')
output = args.output.resolve()
if not output.is_relative_to(Path('/Volumes/Scratch/double-entitle-wp')):
    parser.error('output must be under /Volumes/Scratch/double-entitle-wp')
source = Path(__file__).resolve().parents[1] / 'examples/wordpress/double-entitle-example'
output.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(output, 'x', compression=zipfile.ZIP_DEFLATED) as archive:
    for file in sorted(source.glob('*.php')):
        text = file.read_text()
        if file.name == 'double-entitle-example.php':
            text = text.replace('Version: 1.0.0', 'Version: ' + args.version)
            text = text.replace("__FILE__, '1.0.0'", "__FILE__, '" + args.version + "'")
        archive.writestr('double-entitle-example/' + file.name, text)
print(str(output))
print('sha256=' + hashlib.sha256(output.read_bytes()).hexdigest())
