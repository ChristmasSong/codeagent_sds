import { createFileRoute, Outlet } from '@tanstack/react-router';
import {
  Coins,
  CreditCard,
  HardDrive,
  Home,
  Key,
  LayoutDashboard,
  LifeBuoy,
  Receipt,
  User,
  WalletCards,
} from 'lucide-react';

import { m } from '@/core/i18n/messages';
import { envConfigs } from '@/config';
import { SupportWidget } from '@/blocks/support-widget';
import { AppLayout } from '@/components/app-layout';

export const Route = createFileRoute('/settings')({
  component: SettingsLayout,
});

function SettingsLayout() {
  const group = m['common.systems.settings']();
  const navItems = [
    {
      href: '/settings',
      label: m['settings.nav.overview'](),
      icon: LayoutDashboard,
      group,
    },
    {
      href: '/settings/billing',
      label: m['settings.nav.billing'](),
      icon: CreditCard,
      group,
    },
    {
      href: '/settings/payments',
      label: m['settings.nav.payments'](),
      icon: Receipt,
      group,
    },
    {
      href: '/settings/credits',
      label: m['settings.nav.credits'](),
      icon: Coins,
      group,
    },
    {
      href: '/settings/top-up',
      label: m['settings.nav.topup'](),
      icon: WalletCards,
      group,
    },
    {
      href: '/settings/apikeys',
      label: m['settings.nav.apikeys'](),
      icon: Key,
      group,
    },
    {
      href: '/settings/storage',
      label: m['settings.nav.storage'](),
      icon: HardDrive,
      group,
    },
    {
      href: '/settings/tickets',
      label: m['settings.nav.tickets'](),
      icon: LifeBuoy,
      group,
    },
  ];

  const footerNavItems = [
    {
      href: '/settings/profile',
      label: m['settings.nav.profile'](),
      icon: User,
    },
    { href: '/', label: m['common.systems.home'](), icon: Home, newTab: true },
  ];

  return (
    <AppLayout
      navItems={navItems}
      footerNavItems={footerNavItems}
      brand={envConfigs.app_name}
      brandHref="/settings"
    >
      <Outlet />
      <SupportWidget />
    </AppLayout>
  );
}
