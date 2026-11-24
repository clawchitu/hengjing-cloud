import * as React from 'react'
import { Label as LabelPrimitive, Slot as SlotPrimitive } from 'radix-ui'
import {
  Controller,
  FormProvider,
  useFormContext,
  useFormState,
  type ControllerProps,
  type FieldPath,
  type FieldValues,
} from 'react-hook-form'
import { cn } from '@/lib/utils'

/*
 * shadcn 的 Form（react-hook-form + zod），以后表单统一照这个写：
 *   const form = useForm({ resolver: zodResolver(schema), defaultValues })
 *   <Form {...form}><form onSubmit={form.handleSubmit(onSubmit)}>
 *     <FormField control={form.control} name="x" render={({ field }) => (
 *       <FormItem><FormLabel/><FormControl><input {...field} /></FormControl><FormMessage/></FormItem>
 *     )} />
 * 和 shadcn 原版的差别：FormItem 不加 grid 间距、FormLabel 不加字号颜色，
 * 外观由使用方沿用页面原有的类（登录页的 label / .field），保证接入后界面不变。
 * FormMessage 只在有错误时渲染。
 */

const Form = FormProvider

type FormFieldContextValue<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
> = { name: TName }

const FormFieldContext = React.createContext<FormFieldContextValue>({} as FormFieldContextValue)

const FormField = <
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
>({ ...props }: ControllerProps<TFieldValues, TName>) => (
  <FormFieldContext.Provider value={{ name: props.name }}>
    <Controller {...props} />
  </FormFieldContext.Provider>
)

type FormItemContextValue = {
  id: string
  hasDescription: boolean
  setHasDescription: (v: boolean) => void
  hasMessage: boolean
  setHasMessage: (v: boolean) => void
}
const FormItemContext = React.createContext<FormItemContextValue>({} as FormItemContextValue)

const useFormField = () => {
  const fieldContext = React.useContext(FormFieldContext)
  const itemContext = React.useContext(FormItemContext)
  const { getFieldState } = useFormContext()
  const formState = useFormState({ name: fieldContext.name })
  if (!fieldContext.name) throw new Error('useFormField 只能在 <FormField> 里使用')
  const fieldState = getFieldState(fieldContext.name, formState)
  const { id, hasDescription, hasMessage } = itemContext
  return {
    id,
    hasDescription: !!hasDescription,
    hasMessage: !!hasMessage,
    name: fieldContext.name,
    formItemId: `${id}-form-item`,
    formDescriptionId: `${id}-form-item-description`,
    formMessageId: `${id}-form-item-message`,
    ...fieldState,
  }
}

/** 字段容器。默认不渲染任何元素，避免改动页面原有的 DOM 层级；需要包裹时传 asWrapper */
function FormItem({ asWrapper, className, children, ...props }: React.ComponentProps<'div'> & { asWrapper?: boolean }) {
  const id = React.useId()
  const [hasDescription, setHasDescription] = React.useState(false)
  const [hasMessage, setHasMessage] = React.useState(false)
  const ctx = React.useMemo(() => ({ id, hasDescription, setHasDescription, hasMessage, setHasMessage }), [id, hasDescription, hasMessage])
  return (
    <FormItemContext.Provider value={ctx}>
      {asWrapper ? <div data-slot="form-item" className={className} {...props}>{children}</div> : children}
    </FormItemContext.Provider>
  )
}

function FormLabel({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
  const { error, formItemId } = useFormField()
  return <LabelPrimitive.Root data-slot="form-label" data-error={!!error} className={className} htmlFor={formItemId} {...props} />
}

/**
 * 把 id、aria-invalid、aria-describedby 挂到唯一的子元素上（即真正的 input）。
 * aria-describedby 只引用真正渲染出来的描述（FormDescription）和错误（FormMessage）。
 * 有意不加 data-slot：tailwind.css 对 [data-slot] 的 input 做了小范围重置（内边距清零、字体继承），
 * 会让接入前后的输入框外观不同。
 */
function FormControl({ ...props }: React.ComponentProps<typeof SlotPrimitive.Slot>) {
  const { error, hasDescription, hasMessage, formItemId, formDescriptionId, formMessageId } = useFormField()
  const describedBy = [hasDescription && formDescriptionId, hasMessage && formMessageId].filter(Boolean).join(' ') || undefined
  return (
    <SlotPrimitive.Slot
      id={formItemId}
      aria-describedby={describedBy}
      aria-invalid={!!error}
      {...props}
    />
  )
}

function FormDescription({ className, ...props }: React.ComponentProps<'p'>) {
  const { formDescriptionId } = useFormField()
  const { setHasDescription } = React.useContext(FormItemContext)
  React.useLayoutEffect(() => {
    setHasDescription?.(true)
    return () => setHasDescription?.(false)
  }, [setHasDescription])
  return <p data-slot="form-description" id={formDescriptionId} className={cn('text-[12.5px] text-faint', className)} {...props} />
}

function FormMessage({ className, ...props }: React.ComponentProps<'p'>) {
  const { error, formMessageId } = useFormField()
  const { setHasMessage } = React.useContext(FormItemContext)
  const body = error ? String(error.message ?? '') : props.children
  // 实际渲染了才让 FormControl 的 aria-describedby 引用它
  React.useLayoutEffect(() => {
    if (!body) return
    setHasMessage?.(true)
    return () => setHasMessage?.(false)
  }, [body, setHasMessage])
  if (!body) return null
  return (
    <p data-slot="form-message" id={formMessageId} role="alert" className={cn('text-[12.5px] text-destructive', className)} {...props}>
      {body}
    </p>
  )
}

export { useFormField, Form, FormItem, FormLabel, FormControl, FormDescription, FormMessage, FormField }
