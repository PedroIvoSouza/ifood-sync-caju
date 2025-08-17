# iFood Sync (RPA)

Automação que:
1) Lê o único XLSX na pasta do Google Drive,
2) Interpreta Nome / Estoque / Status Venda,
3) Entra no painel do iFood e atualiza disponibilidade e (se existir) estoque numérico.

## Requisitos
- Node 18+
- Service Account (JSON) com acesso de leitura à pasta do Drive

## Setup
```bash
cp .env.example .env
# edite .env (GDRIVE_FOLDER_ID e GOOGLE_SERVICE_ACCOUNT_JSON)
npm i
