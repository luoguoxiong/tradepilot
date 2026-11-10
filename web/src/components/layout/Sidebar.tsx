import { NavLink } from 'react-router-dom';
import {
  Building2,
  LayoutDashboard,
  Mail,
  Radar,
  Settings,
  Users,
  type LucideIcon,
} from 'lucide-react';

import { cn } from '@/lib/utils';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

const NAV_ITEMS: NavItem[] = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/lead-discovery', label: 'Lead Discovery', icon: Radar },
  { to: '/companies', label: 'Companies', icon: Building2 },
  { to: '/crm', label: 'CRM', icon: Users },
  { to: '/email-studio', label: 'Email Studio', icon: Mail },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export function Sidebar({ collapsed }: { collapsed: boolean }) {
  return (
    <aside
      className={cn(
        'flex h-screen shrink-0 flex-col border-r bg-card transition-all duration-200',
        collapsed ? 'w-16' : 'w-60',
      )}
    >
      <div className="flex h-14 items-center gap-2 border-b px-4">
        <Radar className="size-6 text-primary" />
        {!collapsed && <span className="text-base font-bold tracking-tight">TradePilot AI</span>}
      </div>
      <nav className="flex-1 space-y-1 p-2">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            title={item.label}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground',
                isActive && 'bg-accent text-accent-foreground',
              )
            }
          >
            <item.icon className="size-4 shrink-0" />
            {!collapsed && <span>{item.label}</span>}
          </NavLink>
        ))}
      </nav>
      <div className="border-t p-4 text-xs text-muted-foreground">
        {!collapsed && <span>MVP v0.1</span>}
      </div>
    </aside>
  );
}
