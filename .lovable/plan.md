# Migration history: результат read-only проверки

## Факты
- Текущая история Drizzle согласована: 8 записей (0000–0007), расхождений нет. Схема до Drizzle (старые supabase/migrations) не затрагивается.
- В интерфейсе Lovable (More -> Database -> Manage: SQL editor, Backups, Policies, Settings) нет кнопки или команды «mark as applied» / эквивалента `supabase migration repair`.
- SQL editor не записывает выполненное в историю миграций.
- Через агента в чате доступна ограниченная операция восстановления истории Drizzle (inspect -> план -> repair с подтверждением владельца): восстановить файлы миграций из проверенной ревизии после отката кода, либо закомментировать префикс уже применённых миграций, когда история в БД пуста (remix, Test/Live). Она меняет только файлы репозитория, SQL не выполняет и записи истории в БД напрямую не правит.
- Прямой записи «applied» в таблицу истории без исполнения нет; для произвольной сверки документация направляет в поддержку, которая сравнивает БД с историей.

## Документация
- https://docs.lovable.dev/features/database#how-migrations-run
- https://docs.lovable.dev/features/database#does-the-migration-history-match-my-migration-files

## Следующий шаг
Ничего не менять. Если позже появится расхождение — сначала inspect, затем согласованный repair.
