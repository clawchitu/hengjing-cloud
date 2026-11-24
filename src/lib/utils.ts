import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** 合并类名：clsx 处理条件类，tailwind-merge 去掉互相冲突的 Tailwind 工具类 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
