import { describe, expect, it } from 'vitest'
import { seqNames } from './seqNames'

describe('seqNames（同名用序号区分，不用 id）', () => {
  it('第一个保持原名，第 2 个起加 (2)、(3)；不同名不受影响；同一 key 只算一次', () => {
    const xs = [{ id: 'a', n: '五恒' }, { id: 'b', n: '其他' }, { id: 'c', n: '五恒' }, { id: 'a', n: '五恒' }, { id: 'd', n: '五恒' }]
    const m = seqNames(xs, (x) => x.n, (x) => x.id)
    expect([...m.entries()]).toEqual([['a', '五恒'], ['b', '其他'], ['c', '五恒 (2)'], ['d', '五恒 (3)']])
  })
})
