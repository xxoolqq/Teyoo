<template>
  <div class="login-wrap">
    <form class="login-form" @submit.prevent="onSubmit">
      <h1 class="login-title">后台管理系统</h1>
      <p class="login-sub">登录后使用题目、因材施教、班级管理等功能</p>

      <!-- 新登录接口只认 11 位手机号（后端 ArgsTools.checkPhone），
           原来「手机号或用户 ID」的写法已经不成立 -->
      <label class="field">
        <span class="field-label">手机号</span>
        <input
          v-model.trim="form.phone"
          class="field-input"
          type="text"
          maxlength="11"
          autocomplete="username"
          placeholder="请输入手机号"
        />
      </label>

      <label class="field">
        <span class="field-label">密码</span>
        <input
          v-model="form.passwd"
          class="field-input"
          type="password"
          autocomplete="current-password"
          placeholder="请输入密码"
        />
      </label>

      <label class="field">
        <span class="field-label">验证码</span>
        <div class="code-row">
          <input
            v-model.trim="form.codeMa"
            class="field-input"
            type="text"
            maxlength="4"
            placeholder="请输入验证码"
          />
          <img class="code-img" :src="codeSrc" alt="验证码" title="点击换一张" @click="refreshCode" />
        </div>
      </label>

      <p v-if="error" class="error">{{ error }}</p>

      <button class="submit" type="submit" :disabled="loading">
        {{ loading ? '登录中…' : '登录' }}
      </button>

      <p class="foot">
        还没有账号？<router-link class="link" to="/register">注册账号</router-link>
      </p>

      <p class="hint">接口地址 {{ API_BASE }}</p>
    </form>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { codeMaUrl, login, newCodeMaToken } from '../api/auth'
import { API_BASE } from '../api/endpoints'
import { saveSession } from '../stores/session'

const router = useRouter()

const form = reactive({ phone: '', passwd: '', codeMa: '' })
const uuid = ref(newCodeMaToken())
const loading = ref(false)
const error = ref('')

const codeSrc = computed(() => codeMaUrl(uuid.value))

function refreshCode(): void {
  uuid.value = newCodeMaToken()
}

async function onSubmit(): Promise<void> {
  if (loading.value) return
  error.value = ''

  if (!form.phone || !form.passwd || !form.codeMa) {
    error.value = '手机号、密码、验证码都要填'
    return
  }
  if (!/^1\d{10}$/.test(form.phone)) {
    error.value = '手机号格式不正确'
    return
  }
  if (!/^[A-Za-z0-9]{4}$/.test(form.codeMa)) {
    error.value = '验证码为 4 位字母或数字'
    return
  }

  loading.value = true
  try {
    // 走到这里就一定是成功的：失败由 client 的拦截器抛 ApiError，落到下面 catch
    const data = await login({
      phone: form.phone,
      passwd: form.passwd,
      codeMa: form.codeMa,
      uuid: uuid.value
    })
    saveSession(data)
    await router.push('/home')
  } catch (err) {
    // 桌面端最常见的一种：主窗口 CSP 没放行 connect-src，请求根本没发出去
    error.value = `登录请求失败：${err instanceof Error ? err.message : String(err)}`
    refreshCode()
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.login-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  background: var(--admin-bg, #f4f6f9);
}

.login-form {
  width: 380px;
  padding: 32px 28px;
  border-radius: 10px;
  background: var(--admin-surface, #fff);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.08);
}

.login-title {
  margin: 0;
  font-size: 22px;
  font-weight: 600;
  text-align: center;
  color: var(--admin-text, #1f2d3d);
}

.login-sub {
  margin: 6px 0 22px;
  font-size: 13px;
  text-align: center;
  color: var(--admin-text-weak, #8492a6);
}

.field {
  display: block;
  margin-bottom: 14px;
}

.field-label {
  display: block;
  margin-bottom: 6px;
  font-size: 13px;
  color: var(--admin-text-weak, #8492a6);
}

.field-input {
  width: 100%;
  box-sizing: border-box;
  height: 36px;
  padding: 0 10px;
  font-size: 14px;
  color: var(--admin-text, #1f2d3d);
  border: 1px solid var(--admin-border, #d8dee6);
  border-radius: 6px;
  background: var(--admin-input-bg, #fff);
  outline: none;
}

.field-input:focus {
  border-color: var(--admin-primary, #2d8cf0);
}

.code-row {
  display: flex;
  gap: 8px;
}

.code-img {
  height: 36px;
  flex: none;
  border: 1px solid var(--admin-border, #d8dee6);
  border-radius: 6px;
  cursor: pointer;
  background: #fff;
}

.error {
  margin: 0 0 12px;
  font-size: 13px;
  color: #e5534b;
  word-break: break-all;
}

.submit {
  width: 100%;
  height: 38px;
  font-size: 15px;
  color: #fff;
  border: 0;
  border-radius: 6px;
  background: var(--admin-primary, #2d8cf0);
  cursor: pointer;
}

.submit:disabled {
  opacity: 0.6;
  cursor: default;
}

.foot {
  margin: 14px 0 0;
  font-size: 13px;
  text-align: center;
  color: var(--admin-text-weak, #8492a6);
}

.link {
  color: var(--admin-primary, #2d8cf0);
  text-decoration: none;
}

.link:hover {
  text-decoration: underline;
}

.hint {
  margin: 10px 0 0;
  font-size: 12px;
  text-align: center;
  color: var(--admin-text-weak, #8492a6);
  word-break: break-all;
}
</style>
