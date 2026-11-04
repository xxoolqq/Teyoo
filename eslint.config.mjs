// @ts-check
/**
 * ESLint 9 flat config。
 *
 * 取舍说明：
 *   - 不做 type-aware linting（不传 project）。那需要给每个 tsconfig 建一遍
 *     service，全量跑一次要几十秒，日常编辑用不上；类型正确性交给 typecheck。
 *   - Vue 用 flat/essential：只带正确性规则，不带缩进 / 换行 / 属性排序那些风格
 *     规则 —— 项目现有排版是手工维护的，引入格式规则等于制造几千条噪声。
 *   - 与历史保持一致：代码里 26 处 eslint-disable 全是
 *     @typescript-eslint/no-explicit-any，说明这条规则以前就是「有问题但不是错误」，
 *     这里维持 warn。
 */
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import pluginVue from 'eslint-plugin-vue'
import globals from 'globals'

export default tseslint.config(
  {
    // 构建产物、打包资源、临时调试目录都不进 lint
    ignores: [
      'node_modules/**',
      'dist/**',
      'dist-web/**',
      'dist-webview2/**',
      'release/**',
      'resources/**',
      'patches/**',
      '.tmp-conv/**'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/essential'],
  {
    // .vue 的 <script lang="ts"> 交给 TS 解析器
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser }
    }
  },
  {
    // 主进程 / 预加载 / 构建脚本跑在 Node 里
    files: [
      'src/main/**/*.ts',
      'src/preload/**/*.ts',
      'scripts/**/*.{js,mjs,cjs}',
      'http/**/*.{js,mjs,cjs}',
      '*.config.ts',
      '*.config.mjs'
    ],
    languageOptions: { globals: globals.node }
  },
  {
    // 渲染端与各视图模块跑在 Chromium 里
    files: [
      'src/renderer/**/*.{ts,vue}',
      'src/adminPanel/**/*.{ts,vue}',
      'src/texo/**/*.{ts,vue}',
      'src/visualSolve/**/*.{ts,vue}'
    ],
    languageOptions: { globals: globals.browser }
  },
  {
    // 构建脚本是 CJS，require 是唯一写法
    files: ['scripts/**/*.{js,cjs}', '**/*.cjs'],
    rules: { '@typescript-eslint/no-require-imports': 'off' }
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }
      ],
      // TS 自己就能查未使用变量，关掉基础规则避免重复报
      'no-unused-vars': 'off',
      // App.vue 这类单词组件名不影响正确性
      'vue/multi-word-component-names': 'off',
      // 工具栏里 `cond ? add('active') : remove('active')` 是本文档的既有写法，
      // 三目与短路的「只求值不赋值」在这里是有意的副作用表达式
      '@typescript-eslint/no-unused-expressions': [
        'error',
        { allowTernary: true, allowShortCircuit: true }
      ],
      // 中文排版里全角空格（U+3000）常用于分隔示例，模板字符串里是有意的
      'no-irregular-whitespace': ['error', { skipTemplates: true }]
    }
  }
)
