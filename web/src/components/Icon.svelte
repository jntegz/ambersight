<!-- One-line icons on a 24 px grid. Color comes from currentColor. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script module lang="ts">
  export type IconName =
    | 'worker' | 'cron' | 'budget' | 'errors' | 'runaway' | 'critical' | 'warning' | 'info'
    | 'healthy' | 'search' | 'refresh' | 'logout' | 'external' | 'snooze' | 'check' | 'sun' | 'moon' | 'grid' | 'list' | 'close'
    | 'usage' | 'deprecation' | 'exposure' | 'zombies' | 'timeline' | 'settings' | 'chevron' | 'download' | 'upload'
    | 'mail' | 'webhook' | 'shield' | 'plus' | 'trash' | 'overview' | 'key' | 'arrow';
</script>

<script lang="ts">
  let { name, size = 24, label = '' }: { name: IconName; size?: number; label?: string } = $props();

  const PATHS: Record<IconName, string> = {
    worker: 'M3 8L12 3L21 8V16L12 21L3 16ZM3 8L12 13L21 8M12 13V21',
    cron: 'M20.5 8.5A9 9 0 1 0 21 12M12 7V12L15.5 14M21 4V8.5H16.5',
    budget: 'M4 17A8.5 8.5 0 1 1 20 17M12 14L16 9',
    errors: 'M13 2L5 13.5H11.5L10.5 22L19 10H12.5Z',
    runaway: 'M3 17L9 11L13 15L21 7M15 7H21V13',
    critical: 'M12 3L22 20H2ZM12 9.5V14M12 17.2V17.4',
    warning: 'M21 12A9 9 0 1 1 3 12A9 9 0 1 1 21 12ZM12 7.5V13M12 16.2V16.4',
    info: 'M21 12A9 9 0 1 1 3 12A9 9 0 1 1 21 12ZM12 11V16.5M12 7.8V8',
    healthy: 'M21 12A9 9 0 1 1 15.5 3.7M8 12.5L11 15.5L20 6',
    search: 'M16.5 16.5L21 21M18 10.5A7.5 7.5 0 1 1 3 10.5A7.5 7.5 0 1 1 18 10.5',
    refresh: 'M20 11A8 8 0 1 0 18 16.5M20 4.5V11H13.5',
    logout: 'M14 4H19V20H14M10 8L6 12L10 16M6 12H15',
    external: 'M14 4H20V10M20 4L11 13M18 14V20H4V6H10',
    snooze: 'M6 17V11A6 6 0 0 1 18 11V17L20 19H4ZM10 21H14M15 3H19L15 7H19',
    check: 'M5 12.5L10 17.5L19 7',
    sun: 'M16 12A4 4 0 1 1 8 12A4 4 0 1 1 16 12ZM12 2V4M12 20V22M4.9 4.9L6.3 6.3M17.7 17.7L19.1 19.1M2 12H4M20 12H22M4.9 19.1L6.3 17.7M17.7 6.3L19.1 4.9',
    moon: 'M20 14.5A8 8 0 1 1 9.5 4A6.5 6.5 0 0 0 20 14.5Z',
    grid: 'M4 4H10V10H4ZM14 4H20V10H14ZM4 14H10V20H4ZM14 14H20V20H14Z',
    list: 'M4 6H20M4 12H20M4 18H20',
    close: 'M6 6L18 18M18 6L6 18',
    usage: 'M7 7H17V17H7ZM10 3V7M14 3V7M10 17V21M14 17V21M3 10H7M3 14H7M17 10H21M17 14H21',
    deprecation: 'M4 6H20V20H4ZM4 10H20M8 3V6M16 3V6M10 13L14 17M14 13L10 17',
    exposure: 'M21 12A9 9 0 1 1 3 12A9 9 0 1 1 21 12ZM3 12H21M12 3C9.5 6 9.5 18 12 21M12 3C14.5 6 14.5 18 12 21',
    zombies: 'M5 21V11A7 7 0 0 1 19 11V21L16.5 19L14 21L12 19L10 21L7.5 19ZM9.5 11V11.2M14.5 11V11.2',
    timeline: 'M12 3V9M12 15V21M15 12A3 3 0 1 1 9 12A3 3 0 1 1 15 12Z',
    settings: 'M4 7H14M18 7H20M4 17H6M10 17H20M16 4.5V9.5M8 14.5V19.5',
    chevron: 'M6 9L12 15L18 9',
    download: 'M12 4V15M7 10.5L12 15.5L17 10.5M5 20H19',
    upload: 'M12 16V5M7 9.5L12 4.5L17 9.5M5 20H19',
    mail: 'M3 6H21V18H3ZM3 6L12 13L21 6',
    webhook: 'M8.5 15.5L12 9.5M12 9.5A3 3 0 1 1 15 6.5M15.5 15.5H8.5M15.5 15.5A3 3 0 1 0 18.5 12.5M8.5 15.5A3 3 0 1 1 5.5 12.5',
    shield: 'M12 3L20 6V12C20 16.5 16.5 20 12 21C7.5 20 4 16.5 4 12V6ZM8.5 12L11 14.5L15.5 10',
    plus: 'M12 5V19M5 12H19',
    trash: 'M4 7H20M9 7V4H15V7M6 7L7 20H17L18 7M10 11V16M14 11V16',
    overview: 'M4 4H10V12H4ZM14 4H20V8H14ZM14 12H20V20H14ZM4 16H10V20H4Z',
    key: 'M14.5 9.5A4.5 4.5 0 1 0 10.7 13.8L4 20.5M14.5 9.5H14.6M10.7 13.8L13 16M7 17.5L9 19.5',
    arrow: 'M5 12H19M13 6L19 12L13 18',
  };
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width={size <= 16 ? 2 : 1.5}
  stroke-linecap="round"
  stroke-linejoin="round"
  role={label ? 'img' : undefined}
  aria-label={label || undefined}
  aria-hidden={label ? undefined : 'true'}
>
  <path d={PATHS[name]} />
</svg>
