/**
 * 「创建班级 → 查看编码映射」要把班级带到班级映射页。
 *
 * 与 mapping-items.ts 里那个 key 同一个理由：标签栏按 route.fullPath 归并，
 * 带 query 会按不同 path 开出多个标签页，所以走 sessionStorage 传一次性的入参。
 * 目标页读一次就删，避免下次从菜单直接进来时还停在上次的班级上。
 */
export const CLASS_MAPPING_CLASS_KEY = 'admin.classMapping.classCode'
