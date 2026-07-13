import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';

import { m } from '@/core/i18n/messages';
import { apiGet } from '@/lib/api-client';

import { SettingsForm } from './-settings-form';

function SettingsPage() {
  const { data: user } = useQuery({
    queryKey: ['user-info'],
    queryFn: async () => {
      const data = await apiGet<{
        name?: string;
        email?: string;
        image?: string;
        profession?: string;
      }>('/api/user/info');
      return {
        name: data.name || '',
        email: data.email || '',
        image: data.image || '',
        profession: data.profession || '',
      };
    },
  });

  if (!user) {
    return (
      <div className="text-muted-foreground p-6">
        {m['settings.profile.loading']()}
      </div>
    );
  }

  return (
    <SettingsForm
      name={user.name}
      email={user.email}
      image={user.image}
      profession={user.profession}
    />
  );
}

export const Route = createFileRoute('/settings/profile')({
  component: SettingsPage,
});
