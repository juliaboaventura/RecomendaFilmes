const express = require('express');
const cors = require('cors');
// 1. Importar o módulo 'path'
const path = require('path');
require('dotenv').config();
const neo4j = require('neo4j-driver');

const app = express();
app.use(cors());
app.use(express.json());

// 2. CORREÇÃO: Usar path.join para garantir o caminho absoluto correto para arquivos estáticos
// A PASTA 'public' FOI REMOVIDA AQUI, pois os arquivos estáticos (HTML, CSS, JS) estão na raiz.
app.use(express.static(__dirname));

// Configurar conexão com Neo4j
const driver = neo4j.driver(
    process.env.NEO4J_URI || 
    neo4j.auth.basic(
        process.env.NEO4J_USER ||
        process.env.NEO4J_PASSWORD
    )
);

// Testar conexão ao iniciar
async function testarConexao() {
    const session = driver.session({ database: 'neo4j' });
    try {
        const result = await session.run('RETURN "Conexão OK!" as message');
        console.log('✅ Conectado ao Neo4j:', result.records[0].get('message'));
    } catch (error) {
        console.error('❌ Erro ao conectar no Neo4j:', error);
    } finally {
        await session.close();
    }
}

testarConexao();

// ============ ROTAS DE AUTENTICAÇÃO ============

// Rota de login/cadastro automático
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    
    if (!username || !password) {
        return res.status(400).json({ error: 'Username e senha são obrigatórios' });
    }
    
    const session = driver.session({ database: 'neo4j' });
    try {
        // Busca ou cria o usuário
        const result = await session.run(
            `MERGE (u:User {name: $username, password: $password})
            RETURN u.name as username, ID(u) as userId`, // Use ID(u) se u.userId não for definido
            { username, password }
        );
        
        const user = {
            username: result.records[0].get('username'),
            userId: result.records[0].get('userId')
        };
        
        res.json({ 
            success: true, 
            message: 'Login realizado com sucesso',
            user 
        });
    } catch (error) {
        console.error('Erro no login:', error);
        res.status(500).json({ error: 'Erro ao realizar login' });
    } finally {
        await session.close();
    }
});

// ============ ROTAS DE FILMES ============

// Buscar TODOS os filmes (para o dropdown)
app.get('/api/filmes', async (req, res) => {
    const session = driver.session({ database: 'neo4j' });
    try {
        const result = await session.run(
            'MATCH (m:Movie) RETURN m.title as nome, m.movieId as id ORDER BY m.title'
        );
        
        const filmes = result.records.map(record => ({
            id: record.get('id'),
            nome: record.get('nome')
        }));
        
        res.json(filmes);
    } catch (error) {
        console.error('Erro ao buscar filmes:', error);
        res.status(500).json({ error: 'Erro ao buscar filmes' });
    } finally {
        await session.close();
    }
});

// ============ ROTAS DE AVALIAÇÃO ============

// Salvar avaliação de filme
app.post('/api/avaliar', async (req, res) => {
    const { username, movieId, rating } = req.body;
    
    if (!username || !movieId || !rating || rating < 1 || rating > 5) {
        return res.status(400).json({ error: 'Dados inválidos' });
    }
    
    const session = driver.session({ database: 'neo4j' });
    try {
        await session.run(
            `MATCH (u:User {name: $username})
            MATCH (m:Movie {movieId: $movieId})
            MERGE (u)-[r:RATED]->(m)
            SET r.rating = $rating, r.timestamp = timestamp()
            RETURN m.title as filme, r.rating as nota`,
            { username, movieId: neo4j.int(movieId), rating: neo4j.int(rating) }
        );
        
        res.json({ 
            success: true, 
            message: 'Avaliação registrada com sucesso!' 
        });
    } catch (error) {
        console.error('Erro ao avaliar filme:', error);
        res.status(500).json({ error: 'Erro ao salvar avaliação' });
    } finally {
        await session.close();
    }
});

// Recomendar filme usando A* (caminho mínimo por gênero e avaliações)
app.post('/api/recomendar', async (req, res) => {
    const { username } = req.body;
    
    if (!username) {
        return res.status(400).json({ error: 'Username é obrigatório' });
    }
    
    const session = driver.session({ database: 'neo4j' });
    try {
        const result = await session.run(
            `MATCH (u:User {name: $username})-[r1:RATED]->(m1:Movie)-[:HAS_GENRE]->(g:Genre)
            WHERE r1.rating >= 4
            WITH g, COUNT(*) as generoFrequencia
            ORDER BY generoFrequencia DESC
            LIMIT 1
            
            MATCH (g)<-[:HAS_GENRE]-(m2:Movie)
            WHERE NOT EXISTS {
                MATCH (u2:User {name: $username})-[:RATED]->(m2)
            }
            
            OPTIONAL MATCH (other:User)-[r2:RATED]->(m2)
            WHERE r2.rating >= 4
            
            WITH m2, generoFrequencia,
                 COUNT(DISTINCT other) as numAvaliacoes,
                 AVG(r2.rating) as mediaNotas
            
            WITH m2,
                 (6.0 - COALESCE(mediaNotas, 3.0)) - (generoFrequencia * 2.0) as custoTotal,
                 numAvaliacoes
            
            RETURN m2.title as titulo, 
                   m2.movieId as id,
                   custoTotal,
                   numAvaliacoes
            ORDER BY custoTotal ASC, numAvaliacoes DESC
            LIMIT 5`,
            { username }
        );
        
        if (result.records.length === 0) {
            return res.json({ 
                success: false,
                message: 'Não foi possível gerar recomendações. Avalie mais filmes com nota >= 4!' 
            });
        }
        
        const recomendacoes = result.records.map(record => ({
            titulo: record.get('titulo'),
            id: record.get('id'),
            custo: record.get('custoTotal'),
            avaliacoes: record.get('numAvaliacoes')?.toNumber() || 0
        }));
        
        res.json({ 
            success: true, 
            recomendacoes 
        });
    } catch (error) {
        console.error('Erro ao recomendar filme:', error);
        res.status(500).json({ error: 'Erro ao gerar recomendação' });
    } finally {
        await session.close();
    }
});

// ============ ROTAS DE PÁGINAS ============

// Página de login (Rota principal '/')
app.get('/', (req, res) => {
    // CORREÇÃO: Caminho alterado para a raiz do projeto (não mais 'public')
    const loginPath = path.join(__dirname, 'login.html');
    console.log(`[DEBUG] Tentando servir: ${loginPath}`);
    res.sendFile(loginPath);
});

// Página de login (Rota explícita '/login.html' para evitar o erro Cannot GET)
app.get('/login.html', (req, res) => {
    // CORREÇÃO: Caminho alterado para a raiz do projeto (não mais 'public')
    const loginPath = path.join(__dirname, 'login.html');
    console.log(`[DEBUG] Tentando servir (rota explícita): ${loginPath}`);
    res.sendFile(loginPath);
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
});

// Fechar conexão quando o servidor parar
process.on('SIGINT', async () => {
    await driver.close();
    process.exit();
});


