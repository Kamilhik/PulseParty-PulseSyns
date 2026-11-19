import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@pulsesync/addon-sdk";
import type { PartyController } from "./controller.js";
import { opId } from "./transport.js";

export function PartyPanel({
  controller,
  close,
}: {
  controller: PartyController;
  close: () => void;
}) {
  const view = useSyncExternalStore(controller.subscribe, controller.get);
  const name = view.name;
  const [code, setCode] = useState("");
  const [pairCode, setPairCode] = useState("");
  const [activityType, setActivityType] = useState<"listening" | "playing">("listening");
  const [confirmClose, setConfirmClose] = useState(false);
  const [notice, setNotice] = useState("");
  const root = useRef<HTMLElement>(null);
  const s = view.snapshot;
  const roomsBlocked = view.hostStatus !== "ready";
  const discordAvailable = controller.integrated;
  const owner = s?.ownerId === view.memberId;
  const host = s?.hostId === view.memberId;
  const run = (fn: () => Promise<unknown>) => controller.perform(fn);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    root.current?.querySelector<HTMLElement>("button,input")?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
      if (e.key === "Tab") {
        const elements = Array.from(
          root.current?.querySelectorAll<HTMLElement>(
            "button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href],summary",
          ) ?? [],
        ).filter((el) => el.getClientRects().length > 0);
        const first = elements[0],
          last = elements.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    root.current?.addEventListener("keydown", key);
    const el = root.current;
    return () => {
      el?.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, [close]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(view.invite);
      setNotice("Приглашение скопировано");
    } catch {
      setNotice("Выделите ссылку ниже и скопируйте вручную.");
    }
  };
  return (
    <section ref={root} className="pp">
      <header className="pp-header">
        <div>
          <div className="pp-emblem" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            >
              <circle cx="9" cy="8" r="3" />
              <path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6m3 9v-2a6 6 0 0 0-3-5" />
            </svg>
          </div>
          <h1 id="pp-title">Слушать вместе</h1>
        </div>
        <button className="pp-close" onClick={close} aria-label="Закрыть панель">
          ×
        </button>
      </header>
      <p className="pp-subtitle">
        Включайте любимое и передавайте
        <br />
        пульт друзьям
      </p>
      {roomsBlocked && (
        <div className="pp-host-notice" role="status">
          <strong>
            {view.hostStatus === "checking"
              ? "Проверяем подключение…"
              : view.hostStatus === "unconfigured"
                ? "Сервис комнат ещё не настроен"
              : view.hostStatus === "missing"
                ? "Нужен модуль PulseParty"
                : "Не удалось подключиться"}
          </strong>
          <p>
            {view.hostStatus === "unconfigured"
              ? "PulseParty работает с обычным PulseSync. Для комнат нужен общий HTTPS-сервис; адрес добавляется в сборку аддона."
            : view.hostStatus === "missing"
              ? "Интерфейс установлен. Для совместного прослушивания нужно подключить встроенный модуль в PulseSync."
              : view.hostStatus === "unavailable"
                ? controller.integrated
                  ? "Перезапустите Яндекс Музыку и попробуйте ещё раз."
                  : "Проверьте интернет и доступность сервиса комнат, затем попробуйте ещё раз."
                : ""}
          </p>
          {view.hostStatus !== "checking" && view.hostStatus !== "unconfigured" && (
            <button type="button" onClick={() => run(() => controller.checkHost())}>
              Проверить ещё раз
            </button>
          )}
        </div>
      )}
      {view.error && (
        <p className="pp-error" role="alert">
          {view.error}
        </p>
      )}
      {notice && (
        <p className="pp-notice" role="status">
          {notice}
        </p>
      )}
      {view.pending && (
        <div className="pp-pending">
          <strong>Вас пригласили в комнату</strong>
          <p>
            {s
              ? "Вы сейчас слушаете в другой комнате. Сначала выйдите из неё; приглашение останется здесь."
              : "Примите приглашение, когда будете готовы."}
          </p>
          <div className="pp-actions">
            <Button
              disabled={!!s || view.busy}
              onClick={() =>
                run(async () => {
                  await controller.join(view.pending!.invite);
                  await controller.dismissPending();
                })
              }
            >
              Присоединиться
            </Button>
            <Button variant="text" onClick={() => run(() => controller.dismissPending())}>
              Отклонить
            </Button>
          </div>
        </div>
      )}
      {!s ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => (code.trim() ? controller.join(code) : controller.create()));
          }}
        >
          <label className="pp-field">
            Имя в Яндекс Музыке
            <input
              value={name}
              readOnly
              maxLength={48}
              required
              autoComplete="nickname"
            />
          </label>
          <span className="pp-primary">
            <Button
              color="primary"
              disabled={roomsBlocked || view.busy || !name.trim()}
              onClick={() => run(() => controller.create())}
            >
              Создать комнату
            </Button>
          </span>
          <div className="pp-divider">
            <span>или присоединитесь к друзьям</span>
          </div>
          <label className="pp-field">
            Приглашение
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Ссылка или код комнаты"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <span className="pp-secondary">
            <Button
              variant="outline"
              disabled={roomsBlocked || view.busy || !name.trim() || !code.trim()}
              onClick={() => run(() => controller.join(code))}
            >
              Войти по приглашению
            </Button>
          </span>
        </form>
      ) : (
        <>
          <div className="pp-live">
            <span className="pp-dot" />
            {view.connection}
            <span className="pp-metric">RTT {view.rtt} мс</span>
          </div>
          <div className="pp-track">
            {s.playback.track?.cover ? (
              <img src={s.playback.track.cover} alt="" width="64" height="64" />
            ) : (
              <div className="pp-cover" aria-hidden="true">
                ♫
              </div>
            )}
            <div>
              <strong>{s.playback.track?.title || "Выберите музыку"}</strong>
              <span>{s.playback.track?.artist || "в обычном интерфейсе Яндекс Музыки"}</span>
              <small>{s.playback.playing ? "Воспроизведение" : "Пауза"} · 1×</small>
            </div>
          </div>
          <div className="pp-sync" role="status">
            <span>{view.sync}</span>
            <span>{Math.round(Math.abs(view.drift))} мс</span>
          </div>
          <div className="pp-actions pp-skip">
            <Button variant="outline" disabled={view.busy || !s.hostReady || (!owner && s.skipMode !== "everyone")}
              onClick={() => run(() => controller.action({ type: "skip", direction: "previous", opId: opId() }))}>
              Назад
            </Button>
            <Button variant="outline" disabled={view.busy || !s.hostReady || (!owner && s.skipMode !== "everyone")}
              onClick={() => run(() => controller.action({ type: "skip", direction: "next", opId: opId() }))}>
              Далее
            </Button>
          </div>
          <div className="pp-section-head">
            <h2>В комнате</h2>
            <span>
              {s.members.length} / {s.maxSize}
            </span>
          </div>
          <ul className="pp-members">
            {s.members.map((m) => (
              <li key={m.id}>
                <div className={"pp-avatar" + (!m.connected ? " pp-offline" : "")}>
                  {m.name.slice(0, 1).toLocaleUpperCase()}
                </div>
                <div className="pp-member-name">
                  <strong>
                    {m.name}
                    {m.id === view.memberId ? " · вы" : ""}
                  </strong>
                  <small>
                    {[
                      m.id === s.ownerId ? "Владелец" : "",
                      m.id === s.hostId ? "Ведущий" : "Слушатель",
                      !m.connected
                        ? "Нет связи"
                        : m.error
                          ? "Трек недоступен"
                          : m.ready
                            ? ""
                            : "Подключается",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </small>
                </div>
                {(owner || host) && m.id !== s.hostId && m.connected && (
                  <button
                    disabled={view.busy}
                    className="pp-small"
                    onClick={() =>
                      run(() =>
                        controller.action({ type: "handoff", targetId: m.id, opId: opId() }),
                      )
                    }
                    aria-label={"Передать управление: " + m.name}
                  >
                    Передать пульт
                  </button>
                )}
                {owner && m.id !== view.memberId && (
                  <details className="pp-member-menu">
                    <summary aria-label={"Управление участником: " + m.name}>⋯</summary>
                    <button
                      onClick={() =>
                        run(() =>
                          controller.action({
                            type: "transferOwner",
                            targetId: m.id,
                            opId: opId(),
                          }),
                        )
                      }
                    >
                      Передать владение
                    </button>
                    <button
                      onClick={() =>
                        run(() =>
                          controller.action({
                            type: "kick",
                            targetId: m.id,
                            revokeInvites: true,
                            opId: opId(),
                          }),
                        )
                      }
                    >
                      Удалить и отозвать ссылки
                    </button>
                  </details>
                )}
              </li>
            ))}
          </ul>
          {(owner || host) &&
            s.requests.map((id) => (
              <div className="pp-request" key={id}>
                <span>{s.members.find((m) => m.id === id)?.name} просит пульт</span>
                <button
                  onClick={() =>
                    run(() =>
                      controller.action({
                        type: "decide",
                        targetId: id,
                        accept: true,
                        opId: opId(),
                      }),
                    )
                  }
                >
                  Принять
                </button>
                <button
                  onClick={() =>
                    run(() =>
                      controller.action({
                        type: "decide",
                        targetId: id,
                        accept: false,
                        opId: opId(),
                      }),
                    )
                  }
                >
                  Отклонить
                </button>
              </div>
            ))}
          {!host && (
            <Button
              variant="outline"
              disabled={view.busy || s.requests.includes(view.memberId)}
              onClick={() => run(() => controller.action({ type: "request", opId: opId() }))}
            >
              Попросить управление
            </Button>
          )}
          {owner && (
            <div className="pp-actions">
              <Button
                disabled={view.busy}
                onClick={() =>
                  run(async () => {
                    await controller.action({ type: "invite", profile: false, opId: opId() });
                    setNotice("Ссылка готова. Скопируйте её ниже.");
                  })
                }
              >
                Создать приглашение
              </Button>
              {discordAvailable && <Button
                variant="outline"
                onClick={() =>
                  setNotice(
                    view.discordEnabled
                      ? "Откройте чат друга в Discord → «+» у поля сообщения → приглашение в PulseParty. Владелец должен включить вход из Discord ниже."
                      : "Сначала подключите Discord и включите показ активности ниже.",
                  )
                }
              >
                Пригласить через Discord
              </Button>}
            </div>
          )}
          {view.invite && (
            <label className="pp-field pp-invite">
              Приглашение
              <input readOnly value={view.invite} onFocus={(e) => e.target.select()} />
              <button onClick={() => void copy()}>Скопировать приглашение</button>
            </label>
          )}
          {owner && (
            <details className="pp-management">
              <summary>Настройки комнаты</summary>
              <label className="pp-field">
                Кто может переключать треки
                <select value={s.skipMode ?? "owner"} disabled={view.busy}
                  onChange={event => void run(() => controller.action({ type: "skipMode", mode: event.target.value as "owner" | "everyone", opId: opId() }))}>
                  <option value="owner">Только владелец</option>
                  <option value="everyone">Все участники</option>
                </select>
              </label>
              <p>Кнопки «Назад» и «Далее» переключают очередь ведущего. Передача пульта настраивается отдельно.</p>
              {discordAvailable && <label className="pp-check">
                <input
                  type="checkbox"
                  checked={s.profileJoin}
                  onChange={(e) =>
                    void run(() =>
                      controller.action({
                        type: "profileJoin",
                        enabled: e.target.checked,
                        opId: opId(),
                      }),
                    )
                  }
                />
                Разрешить вход из профиля и приглашений Discord
              </label>}
              {discordAvailable && <p>
                Секрет входа станет доступен в активности Discord на срок до 5 минут. По умолчанию
                вход закрыт.
              </p>}
              <button
                onClick={() =>
                  run(() => controller.action({ type: "revokeInvites", opId: opId() }))
                }
              >
                Отозвать все приглашения
              </button>
            </details>
          )}
          <footer className="pp-room-footer">
            <small>Громкость меняется только у вас</small>
            {owner ? (
              <button className="pp-danger" onClick={() => setConfirmClose(true)}>
                Закрыть комнату
              </button>
            ) : (
              <button
                className="pp-danger"
                onClick={() => run(() => controller.action({ type: "leave", opId: opId() }))}
              >
                Выйти
              </button>
            )}
          </footer>
          {confirmClose && (
            <div className="pp-pending">
              <strong>Закрыть комнату для всех?</strong>
              <p>
                Чтобы выйти и сохранить комнату, сначала передайте владение через меню участника.
              </p>
              <div className="pp-actions">
                <Button
                  onClick={() => run(() => controller.action({ type: "close", opId: opId() }))}
                >
                  Закрыть для всех
                </Button>
                <Button variant="text" onClick={() => setConfirmClose(false)}>
                  Отмена
                </Button>
              </div>
            </div>
          )}
        </>
      )}
      {discordAvailable ? <details className="pp-discord">
        <summary>
          Discord <span>{view.discord}</span>
        </summary>
        <p>
          Для PulseParty отключите обычный Discord RPC в настройках PulseSync. Показ активности
          включается отдельно.
        </p>
        <label className="pp-field">
          {controller.integrated ? "Ваш Discord Application ID" : "Код из окна companion"}
          <input
            value={pairCode}
            onChange={(e) => setPairCode(e.target.value)}
            autoComplete="off"
            placeholder={
              controller.integrated
                ? "Application ID из Developer Portal"
                : "Одноразовый код сопряжения"
            }
          />
        </label>
        {controller.integrated && (
          <label className="pp-field">
            Тип активности
            <select
              value={activityType}
              onChange={(e) => setActivityType(e.target.value as "listening" | "playing")}
            >
              <option value="listening">Listening</option>
              <option value="playing">Playing — совместимый режим</option>
            </select>
          </label>
        )}
        <Button
          variant="outline"
          disabled={!pairCode || view.busy}
          onClick={() =>
            run(async () => {
              if (controller.integrated) await controller.configureDiscord(pairCode, activityType);
              else await controller.pair(pairCode);
              setPairCode("");
            })
          }
        >
          {controller.integrated ? "Подключить Discord" : "Сопрячь"}
        </Button>
        <label className="pp-check">
          <input
            type="checkbox"
            checked={view.discordEnabled}
            onChange={(e) => void run(() => controller.setDiscord(e.target.checked))}
          />
          Показывать мою активность в Discord
        </label>
      </details> : <p className="pp-footnote">Приглашайте друзей ссылкой или кодом. Статус Discord можно включить в обычных настройках PulseSync; вход в комнату через активность Discord стандартному аддону недоступен.</p>}
      <p className="pp-footnote">
        Комната следует за текущим треком ведущего, включая «Мою волну». Каждый слушает через свой
        аккаунт.
      </p>
    </section>
  );
}
