import os
from flask import Flask, request, jsonify, render_template
from flask_sqlalchemy import SQLAlchemy
from flask_login import LoginManager, UserMixin, login_user, logout_user, login_required, current_user
from werkzeug.security import generate_password_hash, check_password_hash

app = Flask(__name__, static_folder='.', static_url_path='')
app.config['SECRET_KEY'] = 'clave-secreta-audiolibros'
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///audiolibros.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

db = SQLAlchemy(app)
login_manager = LoginManager(app)

# --- MODELOS DE BASE DE DATOS ---
class User(UserMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    password = db.Column(db.String(200), nullable=False)

class BookProgress(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    book_id = db.Column(db.String(100), nullable=False)
    progress = db.Column(db.Float, default=0.0)
    __table_args__ = (db.UniqueConstraint('user_id', 'book_id', name='_user_book_uc'),)

@login_manager.user_loader
def load_user(user_id):
    return db.session.get(User, int(user_id))

# --- RUTAS PRINCIPALES ---
@app.route('/')
def index():
    return app.send_static_file('index.html')

@app.route('/api/register', methods=['POST'])
def register():
    data = request.json
    if User.query.filter_by(username=data['username']).first():
        return jsonify({'error': 'El usuario ya existe'}), 400
    
    hashed_pw = generate_password_hash(data['password'], method='pbkdf2:sha256')
    new_user = User(username=data['username'], password=hashed_pw)
    db.session.add(new_user)
    db.session.commit()
    return jsonify({'status': 'ok', 'message': 'Usuario creado exitosamente'})

@app.route('/api/login', methods=['POST'])
def login():
    data = request.json
    user = User.query.filter_by(username=data['username']).first()
    if user and check_password_hash(user.password, data['password']):
        login_user(user, remember=True)
        return jsonify({'status': 'ok', 'username': user.username})
    return jsonify({'error': 'Credenciales incorrectas'}), 401

@app.route('/api/logout', methods=['POST'])
@login_required
def logout():
    logout_user()
    return jsonify({'status': 'ok'})

@app.route('/api/user-status', methods=['GET'])
def user_status():
    if current_user.is_authenticated:
        return jsonify({'authenticated': True, 'username': current_user.username})
    return jsonify({'authenticated': False})

# --- RUTAS DE SINCRONIZACIÓN ---
@app.route('/api/progress', methods=['POST'])
@login_required
def save_progress():
    data = request.json
    book_id = data.get('book_id')
    progress = data.get('progress', 0.0)

    record = BookProgress.query.filter_by(user_id=current_user.id, book_id=book_id).first()
    if not record:
        record = BookProgress(user_id=current_user.id, book_id=book_id, progress=progress)
        db.session.add(record)
    else:
        record.progress = progress

    db.session.commit()
    return jsonify({'status': 'ok'})

@app.route('/api/progress/<book_id>', methods=['GET'])
@login_required
def get_progress(book_id):
    record = BookProgress.query.filter_by(user_id=current_user.id, book_id=book_id).first()
    return jsonify({'progress': record.progress if record else 0.0})

with app.app_context():
    db.create_all()

if __name__ == '__main__':
    app.run(debug=True)