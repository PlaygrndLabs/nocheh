"""Refresh the development code graph using ASTs only, with no model requests."""
import json
import subprocess
from pathlib import Path
from graphify.extract import extract
from graphify.build import build_merge
from graphify.cluster import cluster
from graphify.export import to_json

def main():
    root = Path(__file__).resolve().parents[1]
    files = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard'], cwd=root, text=True).splitlines()
    paths = [root / name for name in files if Path(name).suffix in ('.py', '.ts', '.js', '.mjs') and (root / name).is_file()]
    output = root / 'graphify-out'
    output.mkdir(exist_ok=True)
    extraction = extract(paths, cache_root=root)
    graph = build_merge([extraction], graph_path=str(output / 'graph.json'), root=str(root))
    communities = cluster(graph)
    if not to_json(graph, communities, str(output / 'graph.json')):
        raise SystemExit('Graph export refused; inspect shrink protection before proceeding.')
    (output / 'ast-status.json').write_text(json.dumps({'files': len(paths), 'nodes': graph.number_of_nodes(), 'edges': graph.number_of_edges(), 'model_calls': 0}, indent=2)+'\n')
    print(f'AST graph: {len(paths)} files, {graph.number_of_nodes()} nodes, {graph.number_of_edges()} edges; 0 model calls')


if __name__ == '__main__':
    main()
