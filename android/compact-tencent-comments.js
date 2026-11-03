const COMMENT_FIELDS = ['time_offset', 'content', 'content_style', 'up_count'];

// Preserve only fields consumed by TencentSource.formatComments while keeping
// each barrage entry, array order, and primitive/null entries unchanged.
export function compactTencentBarrageList(items) {
  if (!Array.isArray(items)) return [];
  return items.map(item => {
    if (!item || typeof item !== 'object') return item;
    const compact = {};
    for (const field of COMMENT_FIELDS) compact[field] = item[field];
    return compact;
  });
}
