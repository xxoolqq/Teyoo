<template>
  <div class="register-wrap">
    <form class="register-form" @submit.prevent="onSubmit">
      <h1 class="register-title">用户注册</h1>
      <p class="register-sub">注册后即可登录使用题目、因材施教、班级管理等功能</p>

      <label class="field">
        <span class="field-label">手机号</span>
        <input
          v-model.trim="form.phone"
          class="field-input"
          type="text"
          maxlength="11"
          autocomplete="tel"
          placeholder="请输入手机号"
        />
      </label>

      <div class="row2">
        <label class="field">
          <span class="field-label">密码</span>
          <input
            v-model="form.password"
            class="field-input"
            type="password"
            maxlength="18"
            autocomplete="new-password"
            placeholder="6~18 位字母 + 数字"
          />
        </label>

        <label class="field">
          <span class="field-label">再次输入密码</span>
          <input
            v-model="form.passwd"
            class="field-input"
            type="password"
            maxlength="18"
            autocomplete="new-password"
            placeholder="请再次输入密码"
          />
        </label>
      </div>

      <div class="row2">
        <label class="field">
          <span class="field-label">姓名</span>
          <input
            v-model.trim="form.realName"
            class="field-input"
            type="text"
            maxlength="6"
            autocomplete="name"
            placeholder="请输入姓名"
          />
        </label>

        <div class="field">
          <span class="field-label">类型</span>
          <div class="type-row">
            <label v-for="item in ACCOUNT_TYPES" :key="item.value" class="type-item">
              <input v-model="form.userType" type="radio" :value="item.value" />
              <span>{{ item.label }}</span>
            </label>
          </div>
        </div>
      </div>

      <label class="field">
        <span class="field-label">邮箱</span>
        <input
          v-model.trim="form.mail"
          class="field-input"
          type="text"
          maxlength="100"
          autocomplete="email"
          placeholder="请输入邮箱"
        />
      </label>

      <!-- 后端 ArgsTools.checkSchoolCode：4~6 位数字，必填（空串直接判「学校代码格式有误」） -->
      <label class="field">
        <span class="field-label">学校代码</span>
        <input
          v-model.trim="form.schoolCode"
          class="field-input"
          type="text"
          maxlength="6"
          placeholder="请输入 4~6 位学校代码"
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

      <div class="actions">
        <button class="submit" type="submit" :disabled="loading">
          {{ loading ? '提交中…' : '提交' }}
        </button>
        <button class="reset" type="button" :disabled="loading" @click="onReset">重置</button>
      </div>

      <p class="foot">
        已有账号？<router-link class="link" to="/login">返回登录</router-link>
      </p>
    </form>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { codeMaUrl, newCodeMaToken, register } from '../api/auth'
import { describeError, showSuccess } from '../stores/toast'

const router = useRouter()

/**
 * 账号类型：直接作为注册接口的 userType。后端 register2/v1 只认这两个值
 * （其它值回「用户类型有误」），仅记录注册意愿，权限由后期审核决定。
 */
const ACCOUNT_TYPES = [
  { value: 'parent', label: '家长' },
  { value: 'teacher', label: '教师' }
] as const

const EMPTY_FORM = {
  phone: '',
  password: '',
  passwd: '',
  realName: '',
  mail: '',
  schoolCode: '',
  userType: 'teacher' as 'parent' | 'teacher',
  codeMa: ''
}

const form = reactive({ ...EMPTY_FORM })
const uuid = ref(newCodeMaToken())
const loading = ref(false)
const error = ref('')

const codeSrc = computed(() => codeMaUrl(uuid.value))

function refreshCode(): void {
  uuid.value = newCodeMaToken()
}

function onReset(): void {
  Object.assign(form, EMPTY_FORM)
  error.value = ''
  refreshCode()
}

/**
 * 本地先挡一遍明显填错的再发请求：验证码错、手机号已注册这类只有后端知道，
 * 交给 client 的拦截器翻成 ApiError 弹出来。
 * 这里的规则照抄后端 ArgsTools，口径不一致只会让用户看到「服务器说格式有误」
 * 却不知道哪儿错了。
 */
function validate(): string {
  if (!/^1\d{10}$/.test(form.phone)) return '手机号格式不正确'
  if (!/^(?![0-9]+$)(?![a-zA-Z]+$)[0-9A-Za-z]{6,18}$/.test(form.password)) {
    return '密码需 6~18 位，且字母和数字都要有'
  }
  if (!form.passwd) return '请再次输入密码'
  if (form.password !== form.passwd) return '两次输入的密码不一致'
  if (form.realName.length < 2 || form.realName.length > 6) return '姓名需 2~6 个字符'
  if (form.mail.length < 6 || form.mail.length > 100) return '邮箱长度需 6~100 个字符'
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.mail)) return '邮箱格式不正确'
  if (!/^\d{4,6}$/.test(form.schoolCode)) return '学校代码需 4~6 位数字'
  if (!/^[A-Za-z0-9]{4}$/.test(form.codeMa)) return '验证码为 4 位字母或数字'
  return ''
}

async function onSubmit(): Promise<void> {
  if (loading.value) return
  error.value = ''

  const invalid = validate()
  if (invalid) {
    error.value = invalid
    return
  }

  loading.value = true
  try {
    // 入参对应后端 RegisterArgs；userType 由「类型」单选决定（parent / teacher）
    const userCode = await register({
      phone: form.phone,
      password: form.password,
      passwd: form.passwd,
      realName: form.realName,
      mail: form.mail,
      schoolCode: form.schoolCode,
      userType: form.userType,
      uuid: uuid.value,
      codeMa: form.codeMa
    })
    // 后端返回的是新生成的用户代码，顺手告诉用户（登录用手机号，这个只是账号标识）
    showSuccess(userCode ? `注册成功，用户代码 ${userCode}` : '注册成功')
    // 注册成功后账号里已经有密码了，直接回登录页，不用再点一次
    await router.push('/login')
  } catch (err) {
    error.value = `注册失败：${describeError(err)}`
    // 验证码用过一次就失效了，无论哪种失败都换一张
    refreshCode()
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.register-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  /* 字段比登录页多，窗口矮的时候整张卡片自己滚，不把布局撑破 */
  overflow-y: auto;
  padding: 24px 0;
  box-sizing: border-box;
  background: var(--admin-bg, #f4f6f9);
}

.register-form {
  width: 460px;
  margin: auto;
  padding: 28px 28px 22px;
  border-radius: 10px;
  background: var(--admin-surface, #fff);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.08);
}

.register-title {
  margin: 0;
  font-size: 22px;
  font-weight: 600;
  text-align: center;
  color: var(--admin-text, #1f2d3d);
}

.register-sub {
  margin: 6px 0 20px;
  font-size: 13px;
  text-align: center;
  color: var(--admin-text-weak, #8492a6);
}

/* 两项一行：密码/确认密码、姓名/性别，卡片不至于太高 */
.row2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
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
  font-family: inherit;
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

.type-row {
  display: flex;
  align-items: center;
  gap: 16px;
  height: 36px;
}

.type-item {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 14px;
  color: var(--admin-text, #1f2d3d);
  cursor: pointer;
}

.type-item input {
  margin: 0;
  cursor: pointer;
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

.actions {
  display: flex;
  gap: 10px;
}

.submit {
  flex: 1;
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

.reset {
  width: 90px;
  height: 38px;
  font-size: 14px;
  color: var(--admin-text, #1f2d3d);
  border: 1px solid var(--admin-border, #d8dee6);
  border-radius: 6px;
  background: var(--admin-surface, #fff);
  cursor: pointer;
}

.reset:disabled {
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
</style>
