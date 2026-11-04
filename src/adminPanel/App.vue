<template>
  <!-- .admin-app 是整个应用的样式根：admin.css 里每条规则都挂在它下面，
       这样挂进 Teyoo 时不会把样式漏到宿主身上 -->
  <div class="admin-app">
    <router-view />
    <ToastHost />
  </div>
</template>

<script setup lang="ts">
import ToastHost from './components/ToastHost.vue'
</script>
