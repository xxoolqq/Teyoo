<template>
  <!-- 整窗口的一层浮层，所以必须 Teleport 到 body。
       它原先挂在 .admin-app 里：宿主（ColaMD）把整个应用挂在 #admin-panel 内部，
       那一层是 position: fixed + z-index: 4（base.css:3101），自成层叠上下文 ——
       里面写多大的 z-index 都出不去，而顶部装菜单栏与标签条的那条 #titlebar 是
       z-index: 30（base.css:93），于是提示框一直被压在菜单栏底下。挪到 body 才是
       和它同级比较。
       挪出去不会把样式漏到宿主身上：scoped 样式带 [data-v-…]，只命中这里的元素；
       宿主也没有 .toast 相关的规则（base.css / premium.css 都查过）。 -->
  <Teleport to="body">
    <TransitionGroup name="toast" tag="div" class="toast-host">
      <div v-for="item in toasts" :key="item.id" class="toast" :class="`is-${item.kind}`">
        {{ item.text }}
      </div>
    </TransitionGroup>
  </Teleport>
</template>

<script setup lang="ts">
import { toasts } from '../stores/toast'
</script>

<style scoped>
.toast-host {
  position: fixed;
  /* 让开顶部那 40px：菜单栏、标签条、原生窗口按钮都在里面（#titlebar，
     base.css:81）。算式与 #admin-panel、#file-panel、模态框用的一致 —— 先让出
     标题栏行，再加一点空白（模态框的注释就是这么写的：不遮挡菜单栏）。 */
  top: calc(40px + var(--tab-bar-height, 0px) + 12px);
  left: 50%;
  transform: translateX(-50%);
  /* 高过菜单栏（30）与后台面板那一层（4）。取 1000，与 .search-panel 同档
     （base.css:1602）；仍在模态框（10000）之下 —— 弹窗开着时不该盖住弹窗。 */
  z-index: 1000;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  /* 提示只是给人看的，不该挡住底下的点击 */
  pointer-events: none;
}

/* 挪到 body 之后的代价：切走标签页时宿主管的是**隐藏** #admin-panel（不是卸载），
   正在显示那条提示就跟着飘到编辑器上去了。面板一藏就一起收掉 —— :has() 是项目
   自己的写法（base.css:520 的 body:has(#source-editor.visible)）。 */
body:has(#admin-panel[hidden]) .toast-host {
  display: none;
}

.toast {
  max-width: min(520px, 80vw);
  padding: 8px 14px;
  font-size: 13px;
  line-height: 1.5;
  color: #fff;
  border-radius: 6px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18);
  word-break: break-all;
}

.toast.is-info {
  background: #333d47;
}

.toast.is-error {
  background: #e5534b;
}

.toast.is-success {
  background: #2f9e63;
}

.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}
</style>
