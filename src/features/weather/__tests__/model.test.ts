// /weather、/weather24 回包解析和露点
import sampleRaw from '../../../../docs/api/weather-sample-320500.json?raw'
import { describe, expect, it } from 'vitest'
import { WeatherNoData, dateOf, dewPoint, num, sunOf, timeOf, toWeather24, toWeatherNow, windLevel } from '..'

const sample = JSON.parse(sampleRaw)

describe('字段解析', () => {
  it('湿度、气压、温度、日出日落、风力、时间', () => {
    expect(num('51%')).toBe(51)
    expect(num('1031.3 hPa')).toBe(1031.3)
    expect(num('-3')).toBe(-3)
    expect(num('')).toBeNull(); expect(num(undefined)).toBeNull(); expect(num('_')).toBeNull()
    expect(sunOf('06:31|16:56')).toEqual({ sunrise: '06:31', sunset: '16:56' })
    expect(sunOf('06:31')).toEqual({ sunrise: null, sunset: null })
    expect(windLevel('0-3级 <5.4m/s')).toBe('0-3级')
    expect(windLevel('0-3级 微风  <5.4m/s')).toBe('0-3级')
    expect(windLevel('3级')).toBe('3级')
    expect(windLevel('微风')).toBeNull()
    expect(timeOf('201611061000')).toBe('2016-11-06 10:00')
    expect(timeOf('20261124093438')).toBe('2026-11-24 09:34')
    expect(timeOf('2026112409')).toBeNull()
    expect(dateOf('20261124')).toBe('2026-11-24')
  })

  it('露点：参考值；湿度为 0、缺失、超过 100 时为 null', () => {
    expect(dewPoint(10, 51)).toBe(0.3)
    expect(dewPoint(25, 60)).toBe(16.7)
    expect(dewPoint(30, 100)).toBe(30)
    expect(dewPoint(10, 0)).toBeNull()
    expect(dewPoint(10, null)).toBeNull()
    expect(dewPoint(null, 50)).toBeNull()
    expect(dewPoint(10, 120)).toBeNull()
  })
})

describe('/weather', () => {
  it('样例回包：实时、7 天', () => {
    const v = toWeatherNow(sample)
    expect(v).toMatchObject({ city: '苏州', time: '2026-11-24 09:34', temp: 10, text: '晴', windDirection: '西北风', windPower: '3级', humidity: 51, dew: 0.3, aqi: 35, aqiText: '优质', pm25: 18 })
    expect(v.days).toHaveLength(7)
    expect(v.days[0]).toEqual({ date: '2026-11-24', weekday: 2, dayText: '晴', nightText: '晴', dayCode: '00', high: 13, low: 3, windDirection: '北风', windPower: '0-3级', pressure: 1031.3, rainChance: 0, uv: '强', sunrise: '06:31', sunset: '16:56' })
  })

  it('字段缺失时是 null，不报错；缺的天跳过', () => {
    const v = toWeatherNow({ weather: { now: {}, f2: {} } })
    expect(v).toMatchObject({ city: null, temp: null, humidity: null, dew: null, aqi: null })
    expect(v.days).toHaveLength(1)
    expect(v.days[0].sunrise).toBeNull()
  })

  it('没有数据：weather 缺失、ret_code 非 0、没有 now', () => {
    for (const r of [null, {}, { weather: { ret_code: -1 } }, { weather: { ret_code: -1, now: {} } }, { weather: { f1: {} } }]) expect(() => toWeatherNow(r as never)).toThrow(WeatherNoData)
  })
})

describe('/weather24', () => {
  it('小时数据', () => {
    const v = toWeather24({ weather: { area: '苏州', areaCode: '320500', hourList: [{ time: '202611250700', weather: '晴', weather_code: '00', temperature: '5', wind_direction: '北风', wind_power: '0-3级 微风  <5.4m/s' }] } })
    expect(v).toEqual({ area: '苏州', hours: [{ time: '2026-11-25 07:00', text: '晴', code: '00', temp: 5, windDirection: '北风', windPower: '0-3级' }] })
  })

  it('没有数据：ret_code -1（实测：areaid 或不存在的城市）、hourList 为空或缺失', () => {
    for (const r of [{ weather: { ret_code: -1 } }, { weather: { hourList: [] } }, { weather: {} }, {}]) expect(() => toWeather24(r as never)).toThrow(WeatherNoData)
  })
})
