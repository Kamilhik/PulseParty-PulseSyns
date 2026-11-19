# Необязательный HTTP relay + companion

Этот вариант сохранён из исходного ТЗ. Последний запрос пользователя выбрал встроенную реализацию iroh без отдельной программы и сервера, поэтому для основной установки этот документ не нужен.

Сервер: `server/main.ts`, сборка `dist/services/server/main.js`. Запуск `npm run start:relay`; default bind `127.0.0.1:8787`. Для удалённых друзей нужен собственный HTTPS-домен, DNS и хостинг, которые не предоставлены и автоматически не развёрнуты.

```powershell
Copy-Item .env.example .env
# В .env задайте настоящий PULSEPARTY_RELAY_URL=https://<ваш-домен>
# и PULSEPARTY_DOMAIN=<тот-же-домен>, без угловых скобок.
npm run build
docker compose up --build -d
```

Compose открывает только Caddy на 80/443, Node relay доступен внутри сети контейнеров. Healthcheck — `/health`. На малую компанию достаточно одного сервера. X-Forwarded-For не используется для авторизации или rate limit. За reverse proxy запросы имеют общий адрес и общий лимит: при росте числа комнат настройте его осознанно, не доверяя произвольному заголовку клиента.

Параметры в `.env.example`: 16 участников, maxRooms 1000, TTL приглашения час, grace 20 секунд, idle room TTL час. Состояние в памяти; рестарт закрывает комнаты и инвалидирует сессии/ссылки. Неактивные комнаты очищаются. Публичного каталога нет. Порты и настройки Docker подготовлены, но контейнеры здесь не проверялись.

Страница `/invite#<token>` показывает открытие приложения/копирование кода. Токен находится во fragment, удаляется из адресной строки после чтения и передаётся POST-запросом проверки, а не URL query. Cache-Control=no-store, Referrer-Policy=no-referrer, CSP без внешних скриптов/аналитики. Без подтверждения приложение не объявляется успешно открытым. Мобильным посетителям объясняется требование desktop.

Companion использует `127.0.0.1:18787`, одноразовый код сопряжения на 5 минут и индивидуальный секрет. Для native Discord нужны официальный Social SDK **1.11.24259**, CMake 3.24+, C++20 toolchain. Получите Windows x64 SDK через свой Discord Developer Portal; положите архив в `companion/native/sdk` или укажите DISCORD_SDK_ROOT. CMake должен найти `discordpp.h`, import library и DLL соответствующей архитектуры.

```powershell
cmake -S companion/native -B companion/native/build -A x64 -DDISCORD_SDK_ROOT='C:/path/to/discord-social-sdk'
cmake --build companion/native/build --config Release
npm run start:companion
```

Укажите собственный DISCORD_APPLICATION_ID в `.env`. При другом пути к executable задайте DISCORD_WORKER_PATH. Выберите Listening либо явный Playing в DISCORD_ACTIVITY_TYPE. Без SDK executable основной сценарий HTTP-комнат сохраняется, Discord отмечен как не подключённый.

Для регистрации `pulseparty://` в legacy-режиме есть `scripts/install-companion.ps1`; автозапуск включается только явным `-AutoStart`, удаление регистрации — `-Uninstall`. **Не запускайте этот installer одновременно со встроенным режимом:** протокол и порт общие. В legacy-программе код сопряжения выводится при ручном `npm run start:companion`; секреты приглашений не печатаются.

На Linux/macOS CMake можно вызвать без `-A x64`, передав путь к SDK и библиотеке нужной платформы; `LD_LIBRARY_PATH` / bundle registration настраиваются оператором. Эти платформы не проверены. Современный macOS SDK может поставляться как framework — тогда потребуется соответствующая адаптация CMake, готовый бинарник не обещается.
