// 登录表单的校验规则（zod）。单独成文件，方便单元测试，也是以后表单写校验的样板。
import { z } from 'zod'

export const loginSchema = z.object({
  // 后端字段叫 mobile，但平台账号不一定是手机号（如测试环境的平台账号），所以只校验非空
  account: z.string().trim().min(1, '请输入用户名').max(64, '用户名过长'),
  password: z.string().min(1, '请输入密码').max(128, '密码过长'),
  remember: z.boolean(),
})

export type LoginValues = z.infer<typeof loginSchema>

export const loginDefaults: LoginValues = { account: '', password: '', remember: true }
