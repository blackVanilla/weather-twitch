const tmi = require('tmi.js');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

// Загрузка конфигурации
let config;
const configPath = path.join(__dirname, 'config.json');

// Хранилище последнего использования команды по пользователям
const userCooldowns = new Map(); // ключ: "channel:username", значение: timestamp

async function loadConfig() {
  try {
    const configData = await fs.readFile(configPath, 'utf8');
    config = JSON.parse(configData);
    console.log('Конфигурация загружена успешно');
  } catch (error) {
    console.error('Ошибка загрузки конфига:', error.message);
    process.exit(1);
  }
}

async function saveConfig() {
  try {
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
    console.log('Конфигурация сохранена');
  } catch (error) {
    console.error('Ошибка сохранения конфига:', error.message);
  }
}

// Получение погоды через OpenWeatherMap API
async function getWeather(cityName) {
  try {
    // Сначала получаем координаты города через Geocoding API
    const geoUrl = `http://api.openweathermap.org/geo/1.0/direct`;
    const geoResponse = await axios.get(geoUrl, {
      params: {
        q: cityName,
        limit: 1,
        appid: config.weatherApiKey
      }
    });

    if (!geoResponse.data || geoResponse.data.length === 0) {
      return { error: 'Город не найден' };
    }

    const { lat, lon, name, country } = geoResponse.data[0];

    // Получаем данные о погоде
    const weatherUrl = `https://api.openweathermap.org/data/2.5/weather`;
    const weatherResponse = await axios.get(weatherUrl, {
      params: {
        lat: lat,
        lon: lon,
        appid: config.weatherApiKey,
        units: 'metric',
        lang: 'ru'
      }
    });

    const data = weatherResponse.data;

    // Форматируем направление ветра
    const getWindDirection = (degrees) => {
      const directions = [
        { name: 'северный', emoji: '⬇️' },      // дует с севера на юг (вниз)
        { name: 'северо-восточный', emoji: '↙️' }, // дует с СВ на ЮЗ
        { name: 'восточный', emoji: '⬅️' },     // дует с востока на запад (влево)
        { name: 'юго-восточный', emoji: '↖️' }, // дует с ЮВ на СЗ
        { name: 'южный', emoji: '⬆️' },         // дует с юга на север (вверх)
        { name: 'юго-западный', emoji: '↗️' },  // дует с ЮЗ на СВ
        { name: 'западный', emoji: '➡️' },      // дует с запада на восток (вправо)
        { name: 'северо-западный', emoji: '↘️' } // дует с СЗ на ЮВ
      ];
      const index = Math.round(degrees / 45) % 8;
      return directions[index];
    };

    // Получаем эмодзи для погодных условий на основе полного списка кодов OpenWeatherMap
    const getWeatherEmoji = (conditionId) => {
      // Thunderstorm (2xx)
      if (conditionId >= 200 && conditionId < 300) return '⛈️';

      // Drizzle (3xx)
      if (conditionId >= 300 && conditionId < 400) return '🌦️';

      // Rain (5xx)
      if (conditionId >= 500 && conditionId < 600) {
        if (conditionId === 511) return '🧊'; // Freezing rain
        return '🌧️';
      }

      // Snow (6xx)
      if (conditionId >= 600 && conditionId < 700) {
        if (conditionId === 611 || conditionId === 612 || conditionId === 613) return '🌨️'; // Sleet
        return '❄️';
      }

      // Atmosphere (7xx)
      if (conditionId >= 700 && conditionId < 800) {
        if (conditionId === 701 || conditionId === 741) return '🌫️'; // Mist, Fog
        if (conditionId === 711) return '💨'; // Smoke
        if (conditionId === 721) return '🌫️'; // Haze
        if (conditionId === 731 || conditionId === 751 || conditionId === 761) return '🌪️'; // Dust, Sand
        if (conditionId === 762) return '🌋'; // Volcanic ash
        if (conditionId === 771) return '💨'; // Squalls
        if (conditionId === 781) return '🌪️'; // Tornado
        return '🌫️';
      }

      // Clear (800)
      if (conditionId === 800) return '☀️';

      // Clouds (80x)
      if (conditionId === 801) return '🌤️'; // Few clouds: 11-25%
      if (conditionId === 802) return '⛅'; // Scattered clouds: 25-50%
      if (conditionId === 803) return '🌥️'; // Broken clouds: 51-84%
      if (conditionId === 804) return '☁️'; // Overcast clouds: 85-100%

      return '🌡️'; // По умолчанию
    };

    // Проверяем предупреждения
    const warnings = [];
    if (data.visibility < 1000) {
      warnings.push('низкая видимость');
    }
    if (data.main.temp < 0 && data.main.humidity > 80) {
      warnings.push('возможен гололёд');
    }
    if (data.wind.speed > 15) {
      warnings.push('сильный ветер');
    }

    // Обрабатываем все погодные условия (может быть несколько)
    const weatherConditions = data.weather.map(w => ({
      description: w.description,
      emoji: getWeatherEmoji(w.id)
    }));

    // Первое условие - основное
    const primaryWeather = weatherConditions[0];

    // Если есть дополнительные условия, объединяем их
    let weatherText = primaryWeather.description;
    let weatherEmojis = primaryWeather.emoji;

    if (weatherConditions.length > 1) {
      // Добавляем дополнительные условия
      for (let i = 1; i < weatherConditions.length; i++) {
        weatherText += `, ${weatherConditions[i].description}`;
        weatherEmojis += ` ${weatherConditions[i].emoji}`;
      }
    }

    return {
      city: name,
      country: country,
      countryFlag: getCountryFlag(country),
      temp: data.main.temp.toFixed(1),
      feelsLike: data.main.feels_like.toFixed(1),
      humidity: data.main.humidity,
      windSpeed: data.wind.speed.toFixed(1),
      windDirection: getWindDirection(data.wind.deg),
      condition: weatherText,
      weatherEmoji: weatherEmojis,
      cloudiness: data.clouds.all,
      pressure: Math.round(data.main.pressure * 0.75006), // конвертация из гПа в мм рт.ст.
      warnings: warnings
    };

  } catch (error) {
    console.error('Ошибка получения погоды:', error.message);
    if (error.response && error.response.status === 401) {
      return { error: 'Неверный API ключ OpenWeatherMap' };
    }
    return { error: 'Ошибка при получении данных о погоде' };
  }
}

// Форматирование сообщения с погодой
function formatWeatherMessage(weather) {
  if (weather.error) {
    return weather.error;
  }

  const locationName = weather.countryFlag
    ? `${weather.city}, ${weather.country} ${weather.countryFlag}`
    : `${weather.city}, ${weather.country}`;

  let message = `${locationName}: ${weather.condition} ${weather.weatherEmoji}, ${weather.temp}°C (ощущается как ${weather.feelsLike}°C). ` +
    `Влажность: ${weather.humidity}% 💧. ` +
    `Ветер ${weather.windDirection.name}: ${weather.windSpeed} м/с ${weather.windDirection.emoji}. ` +
    `Облачность: ${weather.cloudiness}% ☁️. ` +
    `Давление: ${weather.pressure} мм рт.ст. 🌡️`;

  if (weather.warnings.length > 0) {
    message += ` ⚠️ Предупреждения: ${weather.warnings.join(', ')}`;
  }

  return message;
}

// Проверка прав пользователя (модератор или владелец канала)
function isModerator(userstate) {
  return userstate.mod ||
    userstate.badges?.broadcaster === '1' ||
    userstate['user-type'] === 'mod';
}

// Получение emoji флага по коду страны (ISO 3166-1 alpha-2)
function getCountryFlag(countryCode) {
  if (!countryCode || countryCode.length !== 2) {
    return '';
  }

  // Конвертируем код страны в emoji флаг
  // Каждая буква кода преобразуется в региональный индикатор
  const codePoints = countryCode
    .toUpperCase()
    .split('')
    .map(char => 127397 + char.charCodeAt(0));

  return String.fromCodePoint(...codePoints);
}

// Проверка тайм-аута для пользователя
function isOnCooldown(channel, username, cooldownSeconds) {
  const key = `${channel}:${username}`;
  const now = Date.now();
  const lastUsed = userCooldowns.get(key);

  if (!lastUsed) {
    return false;
  }

  const timePassed = (now - lastUsed) / 1000; // в секундах
  return timePassed < cooldownSeconds;
}

// Получение оставшегося времени тайм-аута
function getRemainingCooldown(channel, username, cooldownSeconds) {
  const key = `${channel}:${username}`;
  const now = Date.now();
  const lastUsed = userCooldowns.get(key);

  if (!lastUsed) {
    return 0;
  }

  const timePassed = (now - lastUsed) / 1000;
  const remaining = cooldownSeconds - timePassed;
  return Math.ceil(remaining);
}

// Установка времени использования команды
function setCooldown(channel, username) {
  const key = `${channel}:${username}`;
  userCooldowns.set(key, Date.now());
}

async function startBot() {
  await loadConfig();

  const client = new tmi.Client({
    options: { debug: false },
    connection: {
      secure: true,
      reconnect: true
    },
    identity: {
      username: config.botUsername,
      password: config.oauth
    },
    channels: config.channels.map(ch => ch.name)
  });

  client.connect().catch(console.error);

  client.on('connected', (addr, port) => {
    console.log(`✓ Подключено к ${addr}:${port}`);
    console.log(`✓ Активные каналы: ${config.channels.map(ch => ch.name).join(', ')}`);
  });

  client.on('message', async (channel, userstate, message, self) => {
    if (self) return;

    const channelName = channel.replace('#', '');
    const channelConfig = config.channels.find(ch => ch.name === channelName);

    if (!channelConfig) return;

    // Обработка команды !погода
    if (message.toLowerCase().startsWith('!погода')) {
      const args = message.slice(7).trim();

      // !погода помощь
      if (args.toLowerCase() === 'помощь' || args.toLowerCase() === 'help') {
        const cooldownTime = channelConfig.cooldown !== undefined ? channelConfig.cooldown : 15;
        const defaultCity = channelConfig.defaultCity || 'Москва';

        let helpMessage = `📖 Команды: ` +
          `!погода - погода в ${defaultCity} (город по умолчанию) | ` +
          `!погода <город> - погода в указанном городе`;

        if (isModerator(userstate)) {
          helpMessage += ` | !погода установить <город> - изменить город по умолчанию | ` +
            `!погода таймаут <секунды> - установить тайм-аут команды (сейчас: ${cooldownTime} сек)`;
        } else {
          helpMessage += ` | ⏱️ Тайм-аут: ${cooldownTime} сек`;
        }

        client.say(channel, `@${userstate.username}, ${helpMessage}`);
        return;
      }

      // !погода таймаут <секунды>
      if (args.toLowerCase().startsWith('таймаут ')) {
        if (!isModerator(userstate)) {
          client.say(channel, `@${userstate.username}, только модераторы могут менять тайм-аут команды.`);
          return;
        }

        const timeoutValue = parseInt(args.slice(8).trim());
        if (isNaN(timeoutValue) || timeoutValue < 0) {
          client.say(channel, `@${userstate.username}, укажите корректное значение тайм-аута в секундах (например: !погода таймаут 30)`);
          return;
        }

        channelConfig.cooldown = timeoutValue;
        await saveConfig();

        client.say(channel, `@${userstate.username}, тайм-аут команды установлен на ${timeoutValue} секунд ✓`);
        return;
      }

      // !погода установить <город>
      if (args.toLowerCase().startsWith('установить ')) {
        if (!isModerator(userstate)) {
          client.say(channel, `@${userstate.username}, только модераторы могут менять город по умолчанию.`);
          return;
        }

        const newCity = args.slice(11).trim();
        if (!newCity) {
          client.say(channel, `@${userstate.username}, укажите название города.`);
          return;
        }

        // Проверяем, существует ли город
        const weather = await getWeather(newCity);
        if (weather.error) {
          client.say(channel, `@${userstate.username}, ${weather.error}`);
          return;
        }

        // Сохраняем новый город по умолчанию
        channelConfig.defaultCity = weather.city;
        await saveConfig();

        const locationName = weather.countryFlag
          ? `${weather.city}, ${weather.country} ${weather.countryFlag}`
          : `${weather.city}, ${weather.country}`;
        client.say(channel, `@${userstate.username}, город по умолчанию изменён на ${locationName} ✓`);
        return;
      }

      // Проверка тайм-аута (не применяется к модераторам)
      const cooldownTime = channelConfig.cooldown !== undefined ? channelConfig.cooldown : 15;

      if (!isModerator(userstate) && isOnCooldown(channelName, userstate.username, cooldownTime)) {
        const remaining = getRemainingCooldown(channelName, userstate.username, cooldownTime);
        client.say(channel, `@${userstate.username}, команда доступна через ${remaining} сек.`);
        return;
      }

      // !погода <город> или просто !погода
      const cityToCheck = args || channelConfig.defaultCity || 'Москва';

      const weather = await getWeather(cityToCheck);
      const weatherMessage = formatWeatherMessage(weather);

      client.say(channel, `@${userstate.username}, ${weatherMessage}`);

      // Устанавливаем тайм-аут для пользователя (не для модераторов)
      if (!isModerator(userstate)) {
        setCooldown(channelName, userstate.username);
      }
    }
  });

  client.on('disconnected', (reason) => {
    console.log(`✗ Отключено: ${reason}`);
  });
}

// Запуск бота
startBot();
