<!-- One-line icons on a 24 px grid. Color comes from currentColor. -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script module lang="ts">
  export type IconName =
    | 'worker' | 'cron' | 'budget' | 'errors' | 'runaway' | 'critical' | 'warning' | 'info'
    | 'healthy' | 'search' | 'refresh' | 'logout' | 'external' | 'snooze' | 'check';
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
