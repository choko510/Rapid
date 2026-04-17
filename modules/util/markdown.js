let _markedPromise;


function loadMarkedAsync() {
  if (!_markedPromise) {
    _markedPromise = import('marked').then(mod => mod.marked);
  }
  return _markedPromise;
}


export function parseMarkdownAsync(markdown, options) {
  return loadMarkedAsync().then(marked => marked.parse(markdown ?? '', options));
}
