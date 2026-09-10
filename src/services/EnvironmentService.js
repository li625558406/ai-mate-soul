/**
 * EnvironmentService - 环境与感官同步
 *
 * 职责：
 * 1. 获取实时天气数据（wttr.in，免费无需 API Key）
 * 2. 注入日期、星期、节假日信息
 * 3. 根据环境因素生成心情修正提示
 */
export class EnvironmentService {
  constructor() {
    this._weatherCache = null;
    this._weatherCacheTime = 0;
    this._cacheTTL = 30 * 60 * 1000; // 30 分钟缓存

    // 中国主要节假日（2025-2026）
    this._holidays = {
      '01-01': '元旦',
      '01-29': '春节',
      '01-30': '春节',
      '01-31': '春节',
      '02-01': '春节',
      '02-02': '春节',
      '02-12': '元宵节',
      '02-14': '情人节',
      '04-04': '清明节',
      '04-05': '清明节',
      '05-01': '劳动节',
      '05-02': '劳动节',
      '05-03': '劳动节',
      '05-31': '端午节',
      '06-01': '儿童节',
      '08-10': '七夕',
      '09-10': '中秋节',
      '10-01': '国庆节',
      '10-02': '国庆节',
      '10-03': '国庆节',
      '10-04': '国庆节',
      '10-05': '国庆节',
      '10-06': '国庆节',
      '10-07': '国庆节',
      '12-25': '圣诞节',
      '12-31': '跨年夜',
    };

    // 天气 → 心情修正映射（覆盖 wttr.in/worldweatheronline 全部天气描述，保证不透出英文）
    this._weatherMoodMap = {
      'Sunny': { mood: '晴朗', effect: '心情不错，阳光让人舒服' },
      'Clear': { mood: '晴朗', effect: '天气很好，适合出门' },
      'Partly cloudy': { mood: '多云', effect: '' },
      'Cloudy': { mood: '阴天', effect: '有点闷，没什么精神' },
      'Overcast': { mood: '阴天', effect: '灰蒙蒙的，不太想动' },
      'Mist': { mood: '薄雾', effect: '雾蒙蒙的，出门要小心' },
      'Haze': { mood: '雾霾', effect: '灰蒙蒙的，不太想出门' },
      'Fog': { mood: '大雾', effect: '什么都看不清，有点烦' },
      'Freezing fog': { mood: '冻雾', effect: '又冷又有雾，不想出门' },
      'Patchy rain possible': { mood: '可能有雨', effect: '好像要下雨了' },
      'Patchy rain nearby': { mood: '有零星雨', effect: '附近好像在下雨' },
      'Patchy light drizzle': { mood: '毛毛雨', effect: '飘着小雨，还好' },
      'Light drizzle': { mood: '毛毛雨', effect: '飘着小雨，还好' },
      'Freezing drizzle': { mood: '冻毛雨', effect: '又冷又下雨，难受' },
      'Heavy freezing drizzle': { mood: '冻毛雨', effect: '冻雨让人只想躲着' },
      'Patchy light rain': { mood: '小雨', effect: '零零星星的雨，烦人' },
      'Light rain': { mood: '小雨', effect: '下着小雨，有点忧郁' },
      'Moderate rain at times': { mood: '中雨', effect: '时大时小的雨，懒得出门' },
      'Moderate rain': { mood: '中雨', effect: '雨声让人想发呆' },
      'Heavy rain at times': { mood: '大雨', effect: '雨好大，不想出门' },
      'Heavy rain': { mood: '大雨', effect: '雨好大，不想出门' },
      'Light freezing rain': { mood: '冻雨', effect: '冻雨好冷，路上要小心' },
      'Moderate or heavy freezing rain': { mood: '冻雨', effect: '冻雨好冷，路上要小心' },
      'Light sleet': { mood: '雨夹雪', effect: '雨夹雪的天气，又冷又湿' },
      'Moderate or heavy sleet': { mood: '雨夹雪', effect: '雨夹雪的天气，又冷又湿' },
      'Patchy light snow': { mood: '小雪', effect: '好像飘雪了，有点浪漫' },
      'Light snow': { mood: '小雪', effect: '下雪了，好漂亮' },
      'Patchy moderate snow': { mood: '中雪', effect: '雪越下越大了' },
      'Moderate snow': { mood: '中雪', effect: '雪越下越大了' },
      'Patchy heavy snow': { mood: '大雪', effect: '雪好大，世界都变白了' },
      'Heavy snow': { mood: '大雪', effect: '雪好大，世界都变白了' },
      'Ice pellets': { mood: '冰粒', effect: '下冰粒了，打在身上有点疼' },
      'Light rain shower': { mood: '阵雨', effect: '一阵一阵的雨，带伞吧' },
      'Moderate or heavy rain shower': { mood: '大阵雨', effect: '雨说下就下，好烦' },
      'Torrential rain shower': { mood: '暴雨', effect: '暴雨倾盆，哪儿也不想去' },
      'Light sleet showers': { mood: '雨夹雪', effect: '雨夹雪一阵一阵的，好冷' },
      'Moderate or heavy sleet showers': { mood: '雨夹雪', effect: '雨夹雪一阵一阵的，好冷' },
      'Light snow showers': { mood: '阵雪', effect: '一阵一阵的雪，好漂亮' },
      'Moderate or heavy snow showers': { mood: '大雪', effect: '雪好大，世界都变白了' },
      'Light showers of ice pellets': { mood: '冰粒', effect: '下冰粒了，打在身上有点疼' },
      'Moderate or heavy showers of ice pellets': { mood: '冰粒', effect: '冰粒砸得窗户啪啪响' },
      'Patchy light rain in area with thunder': { mood: '雷阵雨', effect: '又打雷又下雨，有点害怕' },
      'Moderate or heavy rain in area with thunder': { mood: '雷阵雨', effect: '又打雷又下雨，有点害怕' },
      'Patchy light snow in area with thunder': { mood: '雷伴雪', effect: '打雷还下雪，好罕见的天气' },
      'Moderate or heavy snow in area with thunder': { mood: '雷伴雪', effect: '打雷还下雪，好罕见的天气' },
      'Thundery outbreaks possible': { mood: '可能有雷雨', effect: '好像要打雷了，有点不安' },
      'Thunderstorm': { mood: '雷暴', effect: '打雷了，有点害怕' },
      'Blowing snow': { mood: '风雪', effect: '风卷着雪，冷得刺骨' },
      'Blizzard': { mood: '暴风雪', effect: '暴风雪，哪儿也去不了' },
      'Patchy snow possible': { mood: '可能有雪', effect: '好像要下雪了' },
      'Patchy sleet possible': { mood: '可能雨夹雪', effect: '可能会下雨夹雪' },
      'Patchy freezing drizzle possible': { mood: '可能冻雨', effect: '可能会结冰，出门小心' },
    };
  }

  /**
   * 获取当前环境上下文
   * @param {{ location?: string }} params
   * @returns {Promise<{ date, weekday, timeOfDay, holiday, weather, weatherEffect, environmentPrompt }>}
   */
  async getEnvironment({ location = '' } = {}) {
    const now = new Date();
    const date = now.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
    const weekday = this._getWeekday(now);
    const timeOfDay = this._getTimeOfDay(now);
    const holiday = this._getHoliday(now);

    // 获取天气（异步，带缓存）
    let weather = null;
    let weatherEffect = '';
    try {
      weather = await this._fetchWeather(location);
      if (weather) {
        const mapped = this._weatherMoodMap[weather.description] || {};
        weatherEffect = mapped.effect || '';
        // 未命中映射的天气描述统一转中文兜底，绝不向前端/prompt 透出英文原文
        weather.mood = mapped.mood || '天气多变';
      }
    } catch {
      // 天气获取失败不影响主流程
    }

    // 生成环境 prompt
    const environmentPrompt = this._buildPrompt({ date, weekday, timeOfDay, holiday, weather, weatherEffect });

    return { date, weekday, timeOfDay, holiday, weather, weatherEffect, environmentPrompt };
  }

  async _fetchWeather(location) {
    // 缓存检查
    if (this._weatherCache && Date.now() - this._weatherCacheTime < this._cacheTTL) {
      return this._weatherCache;
    }

    try {
      const loc = location || 'auto:ip';
      const resp = await fetch(`https://wttr.in/${encodeURIComponent(loc)}?format=j1`, {
        signal: AbortSignal.timeout(5000),
      });
      const data = await resp.json();
      const current = data.current_condition?.[0];
      if (!current) return null;

      const weather = {
        description: current.weatherDesc?.[0]?.value || '未知',
        tempC: current.temp_C,
        feelsLike: current.FeelsLikeC,
        humidity: current.humidity,
        windSpeed: current.windspeedKmph,
      };

      this._weatherCache = weather;
      this._weatherCacheTime = Date.now();
      return weather;
    } catch {
      return this._weatherCache || null; // 降级返回缓存
    }
  }

  _buildPrompt({ date, weekday, timeOfDay, holiday, weather, weatherEffect }) {
    const lines = [`[环境感知] 今天是 ${date}，${weekday}，${timeOfDay}。`];

    if (holiday) {
      lines.push(`今天是${holiday}。`);
    }

    if (weather) {
      let weatherStr = `现在的天气是${weather.mood || weather.description}`;
      if (weather.tempC) weatherStr += `，气温 ${weather.tempC}°C`;
      weatherStr += '。';
      lines.push(weatherStr);
      if (weatherEffect) {
        lines.push(`${weatherEffect}。`);
      }
    }

    lines.push('请根据这些环境因素自然地调整你的语气和话题。比如在深夜可以表现得困倦，在雨天可以表现得低落，在节假日可以主动提起。');

    return lines.join(' ');
  }

  _getWeekday(date) {
    const days = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
    return days[date.getDay()];
  }

  _getTimeOfDay(date) {
    const h = date.getHours();
    if (h >= 5 && h < 8) return '清晨';
    if (h >= 8 && h < 11) return '上午';
    if (h >= 11 && h < 13) return '中午';
    if (h >= 13 && h < 17) return '下午';
    if (h >= 17 && h < 19) return '傍晚';
    if (h >= 19 && h < 23) return '晚上';
    return '深夜';
  }

  _getHoliday(date) {
    const key = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    return this._holidays[key] || null;
  }
}
