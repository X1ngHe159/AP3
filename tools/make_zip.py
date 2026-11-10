"""
tools/make_zip.py —— 把项目打包成可提交的源码 zip
------------------------------------------------------------------
用法：
    python tools/make_zip.py                # 输出 AP3-src.zip 到项目根目录
    python tools/make_zip.py out.zip        # 指定输出文件名

打包内容：index.html、README.md、css/、lib/、src/、assets/、docs/、tools/
排除：本 zip 自身、开发过程中的临时文件（_probe*、PROGRESS.md、CONTRACT.md、__pycache__）
"""
import os
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_OUT = os.path.join(ROOT, 'AP3-src.zip')

EXCLUDE_DIRS = {'__pycache__', '.git', 'node_modules'}
EXCLUDE_FILES = {'PROGRESS.md', 'CONTRACT.md', 'AP3-src.zip'}
EXCLUDE_PREFIX = ('_probe',)


def should_skip(rel_path: str) -> bool:
    parts = rel_path.replace('\\', '/').split('/')
    if any(p in EXCLUDE_DIRS for p in parts):
        return True
    name = parts[-1]
    if name in EXCLUDE_FILES:
        return True
    if name.startswith(EXCLUDE_PREFIX):
        return True
    if name.endswith('.pyc'):
        return True
    return False


def main() -> int:
    out_path = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_OUT
    if out_path.startswith(ROOT) is False:
        # 允许输出到项目外，但提示一下
        print(f'注意：输出到项目目录之外：{out_path}')

    count = 0
    total = 0
    with zipfile.ZipFile(out_path, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for dirpath, dirnames, filenames in os.walk(ROOT):
            dirnames[:] = sorted(d for d in dirnames if d not in EXCLUDE_DIRS)
            for filename in sorted(filenames):
                full = os.path.join(dirpath, filename)
                rel = os.path.relpath(full, ROOT)
                if should_skip(rel):
                    continue
                zf.write(full, rel)
                count += 1
                total += os.path.getsize(full)

    size = os.path.getsize(out_path)
    print(f'已打包 {count} 个文件（原始 {total / 1024 / 1024:.2f} MB）')
    print(f'输出：{out_path}')
    print(f'zip 大小：{size / 1024 / 1024:.2f} MB')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
