/*
 * 集成项目页（管理员）经销商下拉的选项。Radix Select 不允许值为空字符串的选项（会直接抛错白屏），
 * 而经销商列表为空（接口加载中 / 无数据）时 dealerId 是 ''，所以“没有可选经销商”时用非空哨兵值。
 */
export const NO_DEALER = '__no-dealer__'

export interface DealerOption { value: string; label: string; disabled?: boolean }

export function dealerPickModel(hits: { id: string; name: string }[], dealerId: string): { value: string; items: DealerOption[] } {
  if (hits.length) return { value: dealerId, items: hits.map((d) => ({ value: d.id, label: d.name })) }
  const value = dealerId || NO_DEALER
  return { value, items: [{ value, label: '未找到匹配的经销商', disabled: true }] }
}
