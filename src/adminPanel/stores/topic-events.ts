// 题目数据的「脏」广播。
//
// 「录入题目」提交成功、「纠错」提交成功，都会改「我录入的题」列表里的数据。
// 列表页（MyTopicsView）被 KeepAlive 缓存着，人此刻多半在别的标签页 ——
// 与其让用户自己想起来去点刷新，不如改数据的那一方 bump 一下这个版本号，
// 列表页 watch 它自动重拉当前页。一个模块级 ref 就够，不值得上 mitt 之类的
// 事件库。

import { ref } from 'vue'

/** 题目数据版本号：每次增删改成功后 +1。只涨不回，比较大小无意义，只看变化 */
export const topicsVersion = ref(0)

/** 声明「题目数据变了」——录入 / 纠错成功后调用 */
export function bumpTopicsVersion(): void {
  topicsVersion.value += 1
}
